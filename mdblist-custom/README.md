## mdblist list exporter

Python helper to turn a mdblist list URL into JSON containing order, title, and IDs (imdb, trakt, tmdb, tvdb, slug when present).

### Setup

1. Install dependencies:
   ```bash
   pip install -r requirements.txt
   playwright install chromium
   ```

### Usage

```bash
python mdblist_scraper.py "https://mdblist.com/lists/you/your-list" -o list.json
```

Options:

- `--indent 0` for compact JSON (default is `2`).
- `--all-pages` to auto-increment `q_current_page` (caps at `--max-pages`, default 300).
- `--workers` to control concurrent page fetches (default 4).
- Scraper stops after 3 consecutive empty pages (to avoid endless requests when results end).
- omit `-o` to print to stdout.

The script first looks for the Next.js payload in `__NEXT_DATA__`, then falls back to parsing the movie/show cards on search pages. If mdblist changes its page structure the heuristic search may need adjustment.
