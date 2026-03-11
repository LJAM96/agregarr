import logger from '@server/logger';
import type { AxiosError, AxiosInstance } from 'axios';
import axios from 'axios';

export interface MDBListMovie {
  id: number;
  rank: number;
  adult: number;
  title: string;
  imdb_id: string;
  tvdb_id: number | null;
  language: string;
  mediatype: 'movie';
  release_year: number;
  spoken_language: string;
}

export interface MDBListShow {
  id: number;
  rank: number;
  adult: number;
  title: string;
  imdb_id: string;
  tvdb_id: number;
  language: string;
  mediatype: 'show';
  release_year: number;
  spoken_language: string;
}

export interface MDBListItem {
  movie?: MDBListMovie;
  show?: MDBListShow;
}

export interface MDBListResponse {
  movies: MDBListMovie[];
  shows: MDBListShow[];
}

export interface MDBListSummary {
  id: number;
  user_id: number;
  user_name: string;
  name: string;
  slug: string;
  description: string;
  mediatype: 'movie' | 'show';
  items: number;
  likes: number;
  dynamic?: boolean;
  private?: boolean;
}

export interface MDBListUserInfo {
  api_requests: number;
  api_requests_count: number;
  user_id: number;
  patron_status: string;
  patreon_pledge: number;
}

class MDBListAPI {
  private axios: AxiosInstance;

  constructor(apiKey: string) {
    this.axios = axios.create({
      baseURL: 'https://api.mdblist.com',
      params: {
        apikey: apiKey,
      },
      timeout: 30000,
    });
  }

  private async retryRequest<T>(
    requestFn: () => Promise<T>,
    maxRetries = 3,
    delay = 1000
  ): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await requestFn();
      } catch (error: unknown) {
        if (attempt === maxRetries) {
          throw error;
        }

        // Check if it's a retryable error (5xx, 429 rate-limit, or network errors)
        const isAxiosError = axios.isAxiosError(error);
        const status = isAxiosError ? error.response?.status : undefined;
        const isRetryable =
          (status !== undefined && (status >= 500 || status === 429)) ||
          !isAxiosError;

        if (!isRetryable) {
          throw error;
        }

        const errorMessage =
          error instanceof Error ? error.message : String(error);

        logger.debug(
          `MDBList API request failed, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`,
          {
            label: 'MDBList API',
            error: errorMessage,
            status,
          }
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2; // Exponential backoff
      }
    }
    throw new Error('Max retries exceeded');
  }

  /**
   * Extract detailed error information from Axios errors
   */
  private extractErrorDetails(error: unknown): {
    message: string;
    status?: number;
    statusText?: string;
    responseData?: unknown;
  } {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      const statusText = axiosError.response?.statusText;
      const responseData = axiosError.response?.data;

      // Build a detailed error message
      let message = axiosError.message;

      if (status) {
        message = `HTTP ${status}`;
        if (statusText) {
          message += ` ${statusText}`;
        }

        // Add specific context for common errors
        if (status === 401 || status === 403) {
          message +=
            ' - Invalid API key or authentication failed. Please check your MDBList API key in Settings.';
        } else if (status === 404) {
          message +=
            ' - List not found. Please check the MDBList URL is correct.';
        } else if (status === 429) {
          message += ' - Rate limit exceeded. Please try again later.';
        }

        // Include response data if available
        if (responseData) {
          const dataStr =
            typeof responseData === 'string'
              ? responseData
              : JSON.stringify(responseData);
          if (dataStr && dataStr.length < 200) {
            message += ` | Response: ${dataStr}`;
          }
        }
      } else if (axiosError.code === 'ECONNABORTED') {
        message = 'Request timeout - MDBList API did not respond in time';
      } else if (axiosError.code === 'ENOTFOUND') {
        message = 'Network error - Could not reach MDBList API';
      }

      return {
        message,
        status,
        statusText,
        responseData,
      };
    }

    // Not an Axios error - handle other error types
    if (error instanceof Error) {
      return { message: error.message };
    }

    // Handle plain objects with message property
    if (
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof (error as { message: unknown }).message === 'string'
    ) {
      return { message: (error as { message: string }).message };
    }

    // Handle plain objects - try to extract useful information
    if (typeof error === 'object' && error !== null) {
      try {
        const errorObj = error as Record<string, unknown>;
        // Try common error property names
        if (errorObj.error && typeof errorObj.error === 'string') {
          return { message: errorObj.error };
        }
        if (errorObj.msg && typeof errorObj.msg === 'string') {
          return { message: errorObj.msg };
        }
        if (errorObj.detail && typeof errorObj.detail === 'string') {
          return { message: errorObj.detail };
        }
        // Fall back to JSON stringification
        return { message: JSON.stringify(error) };
      } catch {
        // JSON.stringify can fail on circular references
        return { message: 'Unknown error (could not serialize error object)' };
      }
    }

    return { message: String(error) };
  }

  /**
   * Get user's API limits and usage
   */
  public async getUserLimits(): Promise<MDBListUserInfo> {
    try {
      return await this.retryRequest(async () => {
        const response = await this.axios.get<MDBListUserInfo>('/user');
        return response.data;
      });
    } catch (error: unknown) {
      const errorDetails = this.extractErrorDetails(error);

      logger.error('Failed to fetch user limits from MDBList', {
        label: 'MDBList API',
        errorMessage: errorDetails.message,
        httpStatus: errorDetails.status,
        statusText: errorDetails.statusText,
        responseData: errorDetails.responseData,
      });

      throw new Error(`[MDBList] ${errorDetails.message}`);
    }
  }

  /**
   * Get user's lists
   */
  public async getUserLists(): Promise<MDBListSummary[]> {
    try {
      return await this.retryRequest(async () => {
        const response = await this.axios.get<MDBListSummary[]>('/lists/user');
        return response.data;
      });
    } catch (error: unknown) {
      const errorDetails = this.extractErrorDetails(error);

      logger.error('Failed to fetch user lists from MDBList', {
        label: 'MDBList API',
        errorMessage: errorDetails.message,
        httpStatus: errorDetails.status,
        statusText: errorDetails.statusText,
        responseData: errorDetails.responseData,
      });

      throw new Error(`[MDBList] ${errorDetails.message}`);
    }
  }

  /**
   * Get lists from a specific user by username
   */
  public async getUserListsByUsername(
    username: string
  ): Promise<MDBListSummary[]> {
    try {
      return await this.retryRequest(async () => {
        const response = await this.axios.get<MDBListSummary[]>(
          `/lists/user/${username}`
        );
        return response.data;
      });
    } catch (error: unknown) {
      const errorDetails = this.extractErrorDetails(error);

      logger.error(`Failed to fetch lists for user ${username} from MDBList`, {
        label: 'MDBList API',
        errorMessage: errorDetails.message,
        httpStatus: errorDetails.status,
        statusText: errorDetails.statusText,
        responseData: errorDetails.responseData,
        username,
      });

      throw new Error(`[MDBList] ${errorDetails.message}`);
    }
  }

  /**
   * Get list details by ID
   */
  public async getListById(listId: number): Promise<MDBListSummary[]> {
    try {
      return await this.retryRequest(async () => {
        const response = await this.axios.get<MDBListSummary[]>(
          `/lists/${listId}`
        );
        return response.data;
      });
    } catch (error: unknown) {
      const errorDetails = this.extractErrorDetails(error);

      logger.error(`Failed to fetch list ${listId} from MDBList`, {
        label: 'MDBList API',
        errorMessage: errorDetails.message,
        httpStatus: errorDetails.status,
        statusText: errorDetails.statusText,
        responseData: errorDetails.responseData,
        listId,
      });

      throw new Error(`[MDBList] ${errorDetails.message}`);
    }
  }

  /**
   * Get list items by list ID
   */
  public async getListItems(
    listId: number,
    options: {
      limit?: number;
      offset?: number;
      sort?: string;
      order?: 'asc' | 'desc';
      unified?: boolean;
    } = {}
  ): Promise<MDBListResponse> {
    try {
      return await this.retryRequest(async () => {
        const response = await this.axios.get<MDBListResponse>(
          `/lists/${listId}/items`,
          {
            params: {
              limit: options.limit || 100,
              offset: options.offset || 0,
              sort: options.sort,
              order: options.order,
              unified: options.unified,
            },
          }
        );
        return response.data;
      });
    } catch (error: unknown) {
      const errorDetails = this.extractErrorDetails(error);

      logger.error(`Failed to fetch items for list ${listId} from MDBList`, {
        label: 'MDBList API',
        errorMessage: errorDetails.message,
        httpStatus: errorDetails.status,
        statusText: errorDetails.statusText,
        responseData: errorDetails.responseData,
        listId,
        options,
      });

      throw new Error(`[MDBList] ${errorDetails.message}`);
    }
  }

  /**
   * Get list items by username and list name
   */
  public async getListItemsByName(
    username: string,
    listName: string,
    options: {
      limit?: number;
      offset?: number;
      sort?: string;
      order?: 'asc' | 'desc';
      unified?: boolean;
    } = {}
  ): Promise<MDBListResponse> {
    try {
      return await this.retryRequest(async () => {
        const response = await this.axios.get<MDBListResponse>(
          `/lists/${username}/${listName}/items`,
          {
            params: {
              limit: options.limit || 100,
              offset: options.offset || 0,
              sort: options.sort,
              order: options.order,
              unified: options.unified,
            },
          }
        );
        return response.data;
      });
    } catch (error: unknown) {
      const errorDetails = this.extractErrorDetails(error);

      logger.error(
        `Failed to fetch items for list ${username}/${listName} from MDBList`,
        {
          label: 'MDBList API',
          errorMessage: errorDetails.message,
          httpStatus: errorDetails.status,
          statusText: errorDetails.statusText,
          responseData: errorDetails.responseData,
          username,
          listName,
          options,
        }
      );

      throw new Error(`[MDBList] ${errorDetails.message}`);
    }
  }

  /**
   * Get top lists sorted by likes
   */
  public async getTopLists(): Promise<MDBListSummary[]> {
    try {
      return await this.retryRequest(async () => {
        const response = await this.axios.get<MDBListSummary[]>('/lists/top');
        return response.data;
      });
    } catch (error: unknown) {
      const errorDetails = this.extractErrorDetails(error);

      logger.error('Failed to fetch top lists from MDBList', {
        label: 'MDBList API',
        errorMessage: errorDetails.message,
        httpStatus: errorDetails.status,
        statusText: errorDetails.statusText,
        responseData: errorDetails.responseData,
      });

      throw new Error(`[MDBList] ${errorDetails.message}`);
    }
  }

  /**
   * Search for lists by title
   */
  public async searchLists(query: string): Promise<MDBListSummary[]> {
    try {
      return await this.retryRequest(async () => {
        const response = await this.axios.get<MDBListSummary[]>(
          '/lists/search',
          {
            params: { query },
          }
        );
        return response.data;
      });
    } catch (error: unknown) {
      const errorDetails = this.extractErrorDetails(error);

      logger.error(`Failed to search lists for "${query}" from MDBList`, {
        label: 'MDBList API',
        errorMessage: errorDetails.message,
        httpStatus: errorDetails.status,
        statusText: errorDetails.statusText,
        responseData: errorDetails.responseData,
        query,
      });

      throw new Error(`[MDBList] ${errorDetails.message}`);
    }
  }

  /**
   * Parse a MDBList URL to extract useful information
   */
  public parseListUrl(url: string): {
    type: 'user' | 'list' | 'external' | 'search';
    username?: string;
    listName?: string;
    listId?: number;
    searchUrl?: string;
  } | null {
    try {
      // Expected formats:
      // - https://mdblist.com/lists/123456
      // - https://mdblist.com/lists/username/list-name
      // - https://mdblist.com/lists/external/12345
      // - https://mdblist.com/shows/?q=... or https://mdblist.com/movies/?q=...

      const listByIdMatch = url.match(/mdblist\.com\/lists\/(\d+)/);
      const listByNameMatch = url.match(
        /mdblist\.com\/lists\/([^/]+)\/([^/?]+)/
      );
      const externalListMatch = url.match(
        /mdblist\.com\/lists\/external\/(\d+)/
      );

      if (listByIdMatch) {
        return {
          type: 'list',
          listId: parseInt(listByIdMatch[1], 10),
        };
      } else if (externalListMatch) {
        return {
          type: 'external',
          listId: parseInt(externalListMatch[1], 10),
        };
      } else if (listByNameMatch) {
        return {
          type: 'user',
          username: listByNameMatch[1],
          listName: listByNameMatch[2],
        };
      } else if (
        url.includes('/?q=') ||
        url.includes('/?s=') ||
        url.includes('/?q_title=') ||
        url.includes('/search')
      ) {
        return {
          type: 'search',
          searchUrl: url,
        };
      }

      return null;
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      logger.error('Failed to parse MDBList URL', {
        label: 'MDBList API',
        errorMessage,
        url,
      });
      return null;
    }
  }

  /**
   * Scrape items from a MDBList search URL (e.g. /shows/?q=... or /movies/?q=...).
   *
   * MDBList does not expose a search API, so we scrape the HTML pages using
   * JSDOM and a browser-like User-Agent. The method handles pagination via the
   * `q_current_page` / `q_page_next` query-param pattern used by MDBList and
   * stops automatically when a page returns no new items or the safety cap is
   * reached (MAX_PAGES = 20, ~1 000 items).
   */
  public async getSearchListItems(searchUrl: string): Promise<MDBListResponse> {
    try {
      const { JSDOM } = await import('jsdom');
      const { wrapper } = await import('axios-cookiejar-support');
      const { CookieJar } = await import('tough-cookie');

      // MDBList search pages require:
      // 1. A warmup GET to the base page to acquire the mdb_public_search_token
      //    cookie (HttpOnly, 30-min validity) — without it, searches return 403.
      // 2. X-Requested-With: XMLHttpRequest on the search request.
      const MDBLIST_UA =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

      const jar = new CookieJar();
      const scrapeClient = wrapper(
        axios.create({ timeout: 30000, jar })
      );

      const baseHeaders: Record<string, string> = {
        'User-Agent': MDBLIST_UA,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      };

      // Derive base URL (scheme + host + path without query string).
      const parsedUrl = new URL(searchUrl);
      const baseUrl = `${parsedUrl.origin}${parsedUrl.pathname}`;

      // Warmup: acquire session cookies before making the search request.
      logger.debug(`[MDBList] Warming up session: GET ${baseUrl}`, {
        label: 'MDBList API',
      });
      await scrapeClient.get(baseUrl, { headers: baseHeaders });

      const scrapeHeaders: Record<string, string> = {
        ...baseHeaders,
        Referer: baseUrl,
        'X-Requested-With': 'XMLHttpRequest',
      };

      interface SearchItem {
        id: string;
        title: string;
        year?: number;
        type: 'movie' | 'show';
        rank: number;
        imdb_id?: string;
      }

      const items: SearchItem[] = [];

      // Derive media type from the URL path (/movies/ → movie, anything else → show).
      const urlMediaType: 'movie' | 'show' = searchUrl.includes('/movies/')
        ? 'movie'
        : 'show';

      /** Extract SearchItems from a parsed HTML page. */
      const extractItems = (
        dom: InstanceType<typeof JSDOM>,
        rankOffset: number
      ): SearchItem[] => {
        const doc = dom.window.document;
        const cards = doc.querySelectorAll('div.card');
        const pageItems: SearchItem[] = [];

        cards.forEach((card: Element, idx: number) => {
          const header = card.querySelector(
            '.movie-title, .show-title, .header'
          );
          if (!header) return;

          const titleText = header.textContent?.trim() ?? '';
          const yearMatch = titleText.match(/\((\d{4})\)$/);
          const title = yearMatch
            ? titleText.replace(yearMatch[0], '').trim()
            : titleText;
          const year = yearMatch ? parseInt(yearMatch[1], 10) : undefined;

          const link = card.querySelector(
            'a[href^="/movie/"], a[href^="/show/"]'
          );
          const href = link?.getAttribute('href');

          const imdbLink = card.querySelector('a[href*="imdb.com/title/"]');
          const imdb_id =
            imdbLink?.getAttribute('href')?.match(/tt\d+/)?.[0] ?? undefined;

          if (!title) return;

          let itemType: 'movie' | 'show' = urlMediaType;
          if (href) {
            itemType = href.includes('/movie/') ? 'movie' : 'show';
          }

          pageItems.push({
            id: imdb_id ?? `mdblist-${title}-${year ?? 'unk'}`,
            title,
            year,
            type: itemType,
            rank: rankOffset + idx + 1,
            ...(imdb_id ? { imdb_id } : {}),
          });
        });

        return pageItems;
      };

      // Fetch and parse the first page.
      logger.debug(`[MDBList] Scraping search page 1: ${searchUrl}`, {
        label: 'MDBList API',
      });
      const r1 = await scrapeClient.get(searchUrl, {
        headers: scrapeHeaders,
        timeout: 30000,
      });
      const page1Items = extractItems(new JSDOM(r1.data as string), 0);

      if (page1Items.length === 0) {
        logger.warn('[MDBList] No items found on first page of search', {
          label: 'MDBList API',
        });
        return { movies: [], shows: [] };
      }

      items.push(...page1Items);
      logger.debug(`[MDBList] Page 1 yielded ${page1Items.length} items`, {
        label: 'MDBList API',
      });

      // Paginate via q_current_page / q_page_next. Cap at MAX_PAGES to avoid
      // unbounded requests if MDBList's pagination loops or never terminates.
      const MAX_PAGES = 20;

      for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx++) {
        const nextUrl = new URL(searchUrl);
        nextUrl.searchParams.set('q_current_page', String(pageIdx));
        nextUrl.searchParams.set('q_page_next', '1');

        logger.debug(
          `[MDBList] Scraping page ${pageIdx + 2}: ${nextUrl.toString()}`,
          { label: 'MDBList API' }
        );

        try {
          const rNext = await scrapeClient.get(nextUrl.toString(), {
            headers: scrapeHeaders,
            timeout: 30000,
          });
          const nextItems = extractItems(
            new JSDOM(rNext.data as string),
            items.length
          );

          if (nextItems.length === 0) {
            logger.debug('[MDBList] Empty page — pagination complete.', {
              label: 'MDBList API',
            });
            break;
          }

          // If the first item of the next page matches one we already have,
          // MDBList has looped back to the start — stop immediately.
          const alreadyExists = items.some(
            (i) =>
              i.title === nextItems[0].title && i.year === nextItems[0].year
          );
          if (alreadyExists) {
            logger.debug(
              '[MDBList] Duplicate first item detected — pagination complete.',
              { label: 'MDBList API' }
            );
            break;
          }

          items.push(...nextItems);
          logger.debug(
            `[MDBList] Page ${pageIdx + 2} yielded ${
              nextItems.length
            } items. Total: ${items.length}`,
            { label: 'MDBList API' }
          );

          // Brief pause to respect MDBList rate limits.
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (pageError: unknown) {
          logger.error(
            `[MDBList] Error fetching page ${pageIdx + 2}: ${
              pageError instanceof Error ? pageError.message : String(pageError)
            }`,
            { label: 'MDBList API' }
          );
          break;
        }
      }

      // Map scraped items into the standard MDBListResponse shape.
      const movies: MDBListMovie[] = [];
      const shows: MDBListShow[] = [];

      for (const item of items) {
        const base = {
          id: 0, // No TMDB ID from scraping — IMDB fallback will be used
          rank: item.rank,
          adult: 0,
          title: item.title,
          imdb_id: item.imdb_id ?? '',
          tvdb_id: item.type === 'show' ? 0 : (null as unknown as number),
          language: 'en',
          mediatype:
            item.type === 'movie' ? ('movie' as const) : ('show' as const),
          release_year: item.year ?? 0,
          spoken_language: 'en',
        };
        if (item.type === 'movie') {
          movies.push(base as MDBListMovie);
        } else {
          shows.push(base as MDBListShow);
        }
      }

      logger.debug(
        `[MDBList] Search scrape complete — movies: ${movies.length}, shows: ${shows.length}`,
        { label: 'MDBList API' }
      );

      return { movies, shows };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to scrape MDBList search URL', {
        label: 'MDBList API',
        errorMessage: msg,
        searchUrl,
      });
      throw new Error(`[MDBList] Failed to scrape search URL: ${msg}`);
    }
  }

  /**
   * Get custom list items from a URL
   */
  public async getCustomList(
    listUrl: string,
    options: {
      limit?: number;
      offset?: number;
      sort?: string;
      order?: 'asc' | 'desc';
    } = {}
  ): Promise<MDBListResponse> {
    try {
      const parsedUrl = this.parseListUrl(listUrl);

      if (!parsedUrl) {
        throw new Error(
          'Invalid MDBList URL format. Expected: https://mdblist.com/lists/{id} or https://mdblist.com/lists/{username}/{list-name} or https://mdblist.com/(shows|movies)/?q=...'
        );
      }

      if (parsedUrl.type === 'list' && parsedUrl.listId) {
        return await this.getListItems(parsedUrl.listId, options);
      } else if (
        parsedUrl.type === 'user' &&
        parsedUrl.username &&
        parsedUrl.listName
      ) {
        return await this.getListItemsByName(
          parsedUrl.username,
          parsedUrl.listName,
          options
        );
      } else if (parsedUrl.type === 'external' && parsedUrl.listId) {
        // External lists use the same endpoint as regular lists
        return await this.getListItems(parsedUrl.listId, options);
      } else if (parsedUrl.type === 'search' && parsedUrl.searchUrl) {
        return await this.getSearchListItems(parsedUrl.searchUrl);
      } else {
        throw new Error('Unable to determine list type from URL');
      }
    } catch (error: unknown) {
      const errorDetails = this.extractErrorDetails(error);

      logger.error('Failed to fetch custom list from MDBList', {
        label: 'MDBList API',
        errorMessage: errorDetails.message,
        httpStatus: errorDetails.status,
        statusText: errorDetails.statusText,
        responseData: errorDetails.responseData,
        listUrl,
        options,
      });

      throw new Error(`[MDBList] ${errorDetails.message}`);
    }
  }

  /**
   * Test the API connection
   */
  public async testConnection(): Promise<boolean> {
    // Test connection with a simple request to user limits
    // Throw the original error to preserve response status for proper error handling
    await this.getUserLimits();
    return true;
  }
}

export default MDBListAPI;
