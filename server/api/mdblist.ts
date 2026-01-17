import logger from '@server/logger';
import type { AxiosError, AxiosInstance } from 'axios';
import axios from 'axios';
import type { JSDOM } from 'jsdom';

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

        // Check if it's a retryable error (5xx, 429, or network errors)
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
      // const searchMatch = url.match(/mdblist\.com\/(shows|movies)\/\?/);

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
   * Scrape items from a MDBList search URL using JSDOM
   */
  public async getSearchListItems(
    searchUrl: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: {
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<MDBListResponse> {
    try {
      const { JSDOM } = await import('jsdom');

      // MDBList search pages require a browser-like User-Agent to return HTML content

      const MDBLIST_UA =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

      interface MDBListExternalListItem {
        id: string; // imdbId or fallback
        title: string;
        year?: number;
        type: 'movie' | 'show';
        rank: number;
        imdb_id?: string;
      }

      const items: MDBListExternalListItem[] = [];

      // Determine media type from URL (primary indicator)
      const urlMediaType: 'movie' | 'show' = searchUrl.includes('/movies/')
        ? 'movie'
        : 'show';

      // Helper to extract items from HTML
      const extractItems = (dom: JSDOM, currentGlobalRankOffset: number) => {
        const doc = dom.window.document;
        // Try fallback cards
        const cards = doc.querySelectorAll('div.card');
        const pageItems: MDBListExternalListItem[] = [];

        cards.forEach((card: Element, idx: number) => {
          const header = card.querySelector(
            '.movie-title, .show-title, .header'
          );
          if (header) {
            const titleText = header.textContent?.trim() || '';
            // Simple parse: "Title (Year)"
            const yearMatch = titleText.match(/\((\d{4})\)$/);
            const title = yearMatch
              ? titleText.replace(yearMatch[0], '').trim()
              : titleText;
            const year = yearMatch ? parseInt(yearMatch[1], 10) : undefined;

            // Links - try to extract href for type detection
            const link = card.querySelector(
              'a[href^="/movie/"], a[href^="/show/"]'
            );
            const href = link?.getAttribute('href');

            // IDs from links inside
            const imdbLink = card.querySelector('a[href*="imdb.com/title/"]');
            const imdbId = imdbLink?.getAttribute('href')?.match(/tt\d+/)?.[0];

            if (title) {
              // Use href type if found, otherwise use URL-based type
              let itemType: 'movie' | 'show' = urlMediaType;
              if (href) {
                itemType = href.includes('/movie/') ? 'movie' : 'show';
              }

              const item: MDBListExternalListItem = {
                id: imdbId || `mdblist-${title}-${year || 'unk'}`, // Fallback ID
                title,
                year,
                type: itemType,
                rank: currentGlobalRankOffset + idx + 1, // Global order
                ...(imdbId ? { imdb_id: imdbId } : {}),
              };
              pageItems.push(item);
            }
          }
        });
        return pageItems;
      };

      // Page 1
      logger.debug(`[MDBList] Scraping search page 1: ${searchUrl}`);
      const r1 = await axios.get(searchUrl, {
        headers: { 'User-Agent': MDBLIST_UA },
        timeout: 30000,
      });
      const dom1 = new JSDOM(r1.data);
      const page1Items = extractItems(dom1, 0);

      if (page1Items.length === 0) {
        logger.warn('[MDBList] No items found on first page of search');
        return { movies: [], shows: [] };
      }

      page1Items.forEach((i) => items.push(i));
      logger.debug(`[MDBList] Page 1 found ${page1Items.length} items`);

      // Pagination Loop
      let currentPageIndex = 0; // We start "on" page 0 (index-wise).
      // Safety limit: 20 pages max (~1000 items) to prevent infinite loops
      const MAX_PAGES = 20;

      while (currentPageIndex < MAX_PAGES) {
        // Construct Next URL
        // Pattern: q_current_page={currentPageIndex} & q_page_next=1
        // We append these to the original URL.
        const nextUrl = new URL(searchUrl);
        nextUrl.searchParams.set('q_current_page', currentPageIndex.toString());
        nextUrl.searchParams.set('q_page_next', '1');

        logger.debug(
          `[MDBList] Scraping next page (index ${currentPageIndex} -> requests page ${
            currentPageIndex + 2
          }): ${nextUrl.toString()}`
        );

        try {
          const rNext = await axios.get(nextUrl.toString(), {
            headers: { 'User-Agent': MDBLIST_UA },
            timeout: 30000,
          });
          const domNext = new JSDOM(rNext.data);
          const nextItems = extractItems(domNext, items.length);

          if (nextItems.length === 0) {
            logger.debug('[MDBList] No items on next page, stop.');
            break;
          }

          // Check for duplicates (safety against broken pagination)
          const firstNew = nextItems[0];
          const alreadyExists = items.some(
            (i) => i.title === firstNew.title && i.year === firstNew.year
          );

          // If first item already exists, MDBList has looped - stop immediately
          if (alreadyExists) {
            logger.debug(
              '[MDBList] First item of next page already exists. Pagination complete.'
            );
            break;
          }

          nextItems.forEach((i) => {
            i.rank = items.length + 1; // Correct rank globally
            items.push(i);
          });

          logger.debug(
            `[MDBList] Page found ${nextItems.length} new items. Total: ${items.length}`
          );
          currentPageIndex++;

          // Respect rate limits
          await new Promise((r) => setTimeout(r, 1000));
        } catch (e) {
          logger.error(
            `[MDBList] Error fetching next page: ${
              e instanceof Error ? e.message : e
            }`
          );
          break;
        }
      }

      const movies: MDBListMovie[] = [];
      const shows: MDBListShow[] = [];

      items.forEach((item) => {
        if (item.type === 'movie') {
          movies.push({
            id: 0,
            rank: item.rank,
            adult: 0,
            title: item.title,
            imdb_id: item.imdb_id || '',
            tvdb_id: null,
            language: 'en',
            mediatype: 'movie',
            release_year: item.year || 0,
            spoken_language: 'en',
          });
        } else {
          shows.push({
            id: 0,
            rank: item.rank,
            adult: 0,
            title: item.title,
            imdb_id: item.imdb_id || '',
            tvdb_id: 0,
            language: 'en',
            mediatype: 'show',
            release_year: item.year || 0,
            spoken_language: 'en',
          });
        }
      });

      logger.debug(
        `[MDBList Debug] Finished processing. Movies: ${movies.length}, Shows: ${shows.length}`
      );

      return { movies, shows };
    } catch (e) {
      logger.error('Failed to scrape MDBList search URL', {
        label: 'MDBList API',
        errorMessage: e.message,
        searchUrl,
      });
      throw new Error(`[MDBList] Failed to scrape search URL: ${e.message}`);
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
        return await this.getSearchListItems(parsedUrl.searchUrl, options);
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
