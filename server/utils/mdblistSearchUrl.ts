const MDBLIST_HOSTS = new Set(['mdblist.com', 'www.mdblist.com']);

export function isMDBListSearchUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      MDBLIST_HOSTS.has(parsed.hostname) &&
      /^\/(movies|shows)\/?$/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * MDBList search pagination mutates the browser URL with transient state
 * (`q_current_page`, `q_page_next`). Agregarr should always store and sync
 * against the canonical first page so the scraper can paginate deterministically.
 */
export function normalizeMDBListSearchUrl(url: string): string {
  if (!isMDBListSearchUrl(url)) {
    return url;
  }

  const parsed = new URL(url);
  parsed.searchParams.set('q_current_page', '0');
  parsed.searchParams.delete('q_page_next');

  return parsed.toString();
}
