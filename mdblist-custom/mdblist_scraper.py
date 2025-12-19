#!/usr/bin/env python3
"""
Pull a mdblist list URL and emit a JSON array with order, title, and ids using Playwright.

Example:
    python mdblist_scraper.py https://mdblist.com/lists/you/your-list -o list.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any, Iterable

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

# --- Parsing Logic (Reused from original script) ---

def extract_next_data(html: str) -> Any | None:
    """Grab the Next.js payload from the __NEXT_DATA__ script tag."""
    soup = BeautifulSoup(html, "html.parser")
    script = soup.find("script", id="__NEXT_DATA__")
    if not script or not script.string:
        return None
    return json.loads(script.string)


def _looks_like_items(seq: Iterable[Any]) -> bool:
    """Heuristic: a sequence of dicts that mostly have ids/title."""
    items = list(seq)
    if not items or not all(isinstance(item, dict) for item in items):
        return False
    has_ids = sum(1 for item in items if isinstance(item.get("ids"), dict))
    has_title = sum(1 for item in items if item.get("title") or item.get("name"))
    return has_ids >= max(1, len(items) // 2) and has_title >= max(1, len(items) // 2)


def find_items(node: Any) -> list[dict] | None:
    """Recursively search the Next.js payload for the list of entries."""
    if isinstance(node, list):
        if _looks_like_items(node):
            return node  # type: ignore[return-value]
        for item in node:
            found = find_items(item)
            if found:
                return found
    elif isinstance(node, dict):
        for key in ("items", "entries", "list", "shows", "movies", "results"):
            if key in node:
                found = find_items(node[key])
                if found:
                    return found
        for value in node.values():
            found = find_items(value)
            if found:
                return found
    return None


def parse_card_items(html: str) -> list[dict]:
    """Parse the fallback HTML cards on search pages."""
    soup = BeautifulSoup(html, "html.parser")
    cards = soup.select("div.ui.centered.cards div.card") or soup.select("div.card")
    items: list[dict] = []

    def set_if_missing(entry: dict, key: str, value: Any) -> None:
        if value and key not in entry:
            entry[key] = value

    def parse_rating(text: str | None) -> float | None:
        if not text:
            return None
        cleaned = text.strip().strip("/")
        try:
            return float(cleaned)
        except ValueError:
            return None

    for idx, card in enumerate(cards):
        entry: dict[str, Any] = {"order": idx + 1}

        header = card.find(class_=re.compile(r"(movie|show)-title"))
        if header:
            header_text = header.get_text(" ", strip=True)
            year_match = re.search(r"\((\d{4})\)", header_text)
            if year_match:
                entry["year"] = int(year_match.group(1))
            title = re.sub(r"\s*\(\d{4}\)\s*", "", header_text).strip()
            if title:
                entry["title"] = title

        slug_link = card.find("a", href=re.compile(r"^/(movie|show)/"))
        if slug_link and slug_link.get("href"):
            slug_path = slug_link["href"].split("?")[0].rstrip("/")
            slug = slug_path.rsplit("/", 1)[-1]
            set_if_missing(entry, "slug", slug)
            if "type" not in entry:
                entry["type"] = "movie" if "/movie/" in slug_path else "show"

        for grid in card.select("div.ui.grid"):
            anchor = grid.find("a", href=True)
            if not anchor:
                continue
            href = anchor["href"]
            label = anchor.get_text(strip=True).lower()
            rating_div = grid.find("div", class_=re.compile(r"three wide column idtext"))
            rating = parse_rating(rating_div.get_text() if rating_div else None)

            imdb_match = re.search(r"imdb\.com/title/(tt\d+)", href)
            if imdb_match:
                set_if_missing(entry, "imdb", imdb_match.group(1))
                if rating is not None:
                    set_if_missing(entry, "imdb_score", rating)

            trakt_match = re.search(r"trakt\.tv/(movies|shows)/([^/?#]+)", href)
            if trakt_match:
                set_if_missing(entry, "trakt", trakt_match.group(2))
                if "type" not in entry:
                    entry["type"] = "movie" if trakt_match.group(1) == "movies" else "show"
                if rating is not None:
                    set_if_missing(entry, "trakt_score", rating)

            tmdb_match = re.search(r"themoviedb\.org/(movie|tv)/(\d+)", href)
            if tmdb_match:
                set_if_missing(entry, "tmdb", tmdb_match.group(2))
                if "type" not in entry:
                    entry["type"] = "movie" if tmdb_match.group(1) == "movie" else "show"
                if rating is not None:
                    set_if_missing(entry, "tmdb_score", rating)
            
            # Additional parsers can be added here if needed

            if "rogerebert" in label:
                if rating is not None:
                    set_if_missing(entry, "rogerebert_score", rating)

        if entry.get("title") or any(k in entry for k in ("imdb", "trakt", "tmdb", "tvdb", "slug")):
            items.append(entry)

    return items


def normalize_item(raw: dict, index: int) -> dict:
    """Shape a raw item dict into the desired output schema."""
    ids = raw.get("ids") if isinstance(raw.get("ids"), dict) else {}

    def pick(*keys: str) -> Any:
        for key in keys:
            value = raw.get(key)
            if value:
                return value
        return None

    entry: dict[str, Any] = {"order": index + 1}
    title = pick("title", "name")
    if title:
        entry["title"] = title
    year = pick("year", "releaseYear", "first_aired_year", "release_year")
    if year:
        entry["year"] = year
    media_type = pick("type", "media_type", "mediaType", "kind")
    if media_type:
        entry["type"] = media_type

    def add_id(key: str, *alt_keys: str) -> None:
        value = None
        if isinstance(ids, dict):
            value = ids.get(key)
        if not value:
            for alt in alt_keys:
                alt_val = raw.get(alt)
                if alt_val:
                    value = alt_val
                    break
        if value:
            entry[key] = value

    add_id("imdb", "imdb_id")
    add_id("trakt", "trakt_id")
    add_id("tmdb", "tmdb_id")
    add_id("tvdb", "tvdb_id")
    add_id("slug")

    return entry


def dedup_key(entry: dict[str, Any]) -> str | None:
    """Generate a stable key to avoid duplicates across pages."""
    for key in ("imdb", "trakt", "tmdb", "tvdb", "slug"):
        if entry.get(key):
            return f"{key}:{entry[key]}"
    title = entry.get("title")
    year = entry.get("year")
    if title:
        return f"title:{title}|{year or ''}"
    return None


def extract_items_from_html(html: str) -> list[dict]:
    """Extract normalized items from either Next.js payload or fallback cards."""
    data = extract_next_data(html)
    if data:
        items = find_items(data)
        if items:
            return [normalize_item(item, idx) for idx, item in enumerate(items)]

    return parse_card_items(html)


# --- Playwright Scraper ---

def scrape_with_playwright(url: str, all_pages: bool, max_pages: int) -> list[dict]:
    results: list[dict] = []
    seen: set[str] = set()

    with sync_playwright() as p:
        # Launch browser - headless by default
        browser = p.chromium.launch(headless=True)
        # Create a context with a realistic user agent and viewport
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 720}
        )
        page = context.new_page()

        print(f"Navigating to {url}...", file=sys.stderr)
        try:
            page.goto(url, timeout=60000, wait_until="domcontentloaded")
        except PlaywrightTimeoutError:
            print("Timeout loading initial page, but continuing...", file=sys.stderr)

        page_count = 0
        while True:
            # Wait a bit for dynamic content (hydration)
            # We can wait for the cards to appear
            try:
                page.wait_for_selector("div.card", timeout=10000)
            except Exception:
                print("Warning: Timed out waiting for cards selector.", file=sys.stderr)

            # Get content and parse
            content = page.content()
            items = extract_items_from_html(content)
            
            added_count = 0
            if items:
                for item in items:
                    key = dedup_key(item)
                    if key and key in seen:
                        continue
                    if key:
                        seen.add(key)
                    item["order"] = len(results) + 1
                    results.append(item)
                    added_count += 1
                
                print(f"Page {page_count+1}: Found {len(items)} items ({added_count} new). Total unique: {len(results)}", file=sys.stderr)
            else:
                 print(f"Page {page_count+1}: No items found.", file=sys.stderr)

            page_count += 1
            if not all_pages or page_count >= max_pages:
                break
            
            if added_count == 0:
                 # If we didn't add anything new, we might be stuck or done.
                 print("No new items found on this page. Stopping.", file=sys.stderr)
                 break

            # Pagination Logic
            # Look for the "Next" button. 
            # In Semantic UI pagination, the active item is usually a number, and next is an 'item' anchor 
            # that contains a right chevron icon or text.
            # Based on inspection, the pagination generally has standard numbered links.
            
            # The pagination is a submit button in a form
            next_button = page.locator('button[name="q_page_next"]').first
            
            if not next_button.count():
                 print("Next button not found. Dumping HTML to page_dump.html", file=sys.stderr)
                 Path("page_dump.html").write_text(page.content(), encoding="utf-8")
                 break
            
            # Check if disabled
            if "disabled" in (next_button.get_attribute("class") or ""):
                 print("Next button is disabled. Reached end of list.", file=sys.stderr)
                 break

            print("Clicking Next...", file=sys.stderr)
            try:
                with page.expect_navigation(timeout=30000, wait_until="domcontentloaded"):
                    next_button.click()
            except PlaywrightTimeoutError:
                 print("Navigation timeout after clicking Next. Retrying...", file=sys.stderr)
                 # Sometimes it's just an AJAX update, not full nav
                 time.sleep(2)
            except Exception as e:
                 print(f"Error navigating: {e}", file=sys.stderr)
                 break
        
        browser.close()

    return results


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export a mdblist list to JSON using Playwright.")
    parser.add_argument("url", help="mdblist list URL")
    parser.add_argument(
        "-o",
        "--output",
        help="Write JSON to this file (defaults to stdout).",
    )
    parser.add_argument(
        "--indent",
        type=int,
        default=2,
        help="Indent for pretty JSON (0 for compact). Default: 2",
    )
    parser.add_argument(
        "--all-pages",
        action="store_true",
        default=True,
        help="Follow pagination (default: on).",
    )
    parser.add_argument(
        "--single-page",
        action="store_true",
        help="Fetch only the first page.",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=300,
        help="Safety cap when --all-pages is set. Default: 300",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    all_pages = args.all_pages and not args.single_page
    
    try:
        output = scrape_with_playwright(args.url, all_pages=all_pages, max_pages=args.max_pages)
    except Exception as e:
        print(f"Scraping failed: {e}", file=sys.stderr)
        return 1

    indent = None if args.indent == 0 else args.indent
    serialized = json.dumps(output, indent=indent)

    if args.output:
        path = Path(args.output)
        path.write_text(serialized + ("\n" if not serialized.endswith("\n") else ""), encoding="utf-8")
        print(f"Wrote {len(output)} items to {path}", file=sys.stderr)
    else:
        sys.stdout.write(serialized)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
