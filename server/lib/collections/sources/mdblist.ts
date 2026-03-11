import MDBListAPI, {
  type MDBListMovie,
  type MDBListResponse,
  type MDBListShow,
} from '@server/api/mdblist';
import type PlexAPI from '@server/api/plexapi';
import { BaseCollectionSync } from '@server/lib/collections/core/BaseCollectionSync';
import {
  findPlexItemsByTmdbIds,
  getCollectionMediaType,
  processMissingItemsWithMode,
  type LibraryItemsCache,
} from '@server/lib/collections/core/CollectionUtilities';
import type {
  CollectionItem,
  CollectionOperationResult,
  CollectionSyncOptions,
  FilteringStats,
  MDBListSourceData,
  MDBListTemplateContext,
  MissingItem,
  PlexCollection,
  PlexLookupResult,
  SyncResult,
} from '@server/lib/collections/core/types';
import { CollectionSyncErrorType } from '@server/lib/collections/core/types';
import type { CollectionConfig } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';

interface MDBListCollectionItem extends CollectionItem {
  tmdbId: number;
}

/**
 * MDBList Collection Sync implementation using the base class
 *
 * Handles MDBList API types (user lists, top lists, custom lists)
 * with auto-request functionality and comprehensive error handling.
 */
export class MDBListCollectionSync extends BaseCollectionSync<'mdblist'> {
  private mdblistClients: Map<string, MDBListAPI> = new Map();

  constructor() {
    super('mdblist');
  }

  /**
   * Validate that MDBList API is properly configured
   */
  protected async validateConfiguration(): Promise<void> {
    const settings = getSettings();
    if (!settings.mdblist.apiKey) {
      throw this.createSyncError(
        CollectionSyncErrorType.CONFIGURATION_ERROR,
        'MDBList API key not configured'
      );
    }
  }

  /**
   * Process a single MDBList collection configuration
   */
  protected async processConfiguration(
    config: CollectionConfig,
    plexClient: PlexAPI,
    allCollections: PlexCollection[],
    processedCollectionKeys?: Set<string>,
    libraryCache?: LibraryItemsCache,
    options?: CollectionSyncOptions
  ): Promise<SyncResult> {
    try {
      // Validate configuration
      if (!this.isValidMDBListConfig(config)) {
        throw this.createSyncError(
          CollectionSyncErrorType.CONFIGURATION_ERROR,
          `Invalid MDBList configuration: ${config.name}`
        );
      }

      // Fetch data from MDBList API
      const sourceData = await this.fetchSourceData(
        config,
        options,
        libraryCache
      );

      // Map to standardized format
      const mappedResult = await this.mapSourceDataToItems(
        sourceData,
        config,
        plexClient,
        libraryCache
      );

      // Apply filtering safety net (validation, deduplication, maxItems safety check)
      const { items, missingItems, mappingStats, filteringStats } =
        await this.applyFilteringToMappedItems(mappedResult, config);

      // Tag existing items in Radarr/Sonarr (if enabled)
      await this.tagExistingItemsInArr(items, config);

      // Handle placeholder cleanup and process missing items
      const placeholderItems = await this.handlePlaceholdersAndMissingItems(
        items,
        missingItems,
        config,
        plexClient,
        libraryCache,
        missingItems && missingItems.length > 0
          ? () => this.handleAutoRequests(missingItems, config)
          : undefined
      );

      // Add placeholder items to the collection
      let finalItems = items;
      if (placeholderItems.length > 0) {
        finalItems = [...items, ...placeholderItems];
      }

      if (finalItems.length === 0) {
        logger.warn('No items to create collection from', {
          label: 'MDBList Collections',
          configName: config.name,
          originalStatsCount: mappingStats?.original || 0,
          mappedCount: mappingStats?.filtered || 0,
          filteredCount: filteringStats?.filtered || 0,
          removedCount:
            (mappingStats?.removed || 0) + (filteringStats?.removed || 0),
        });
        return { created: 0, updated: 0 };
      }

      // Use the new media type processing strategy
      return await this.processWithMediaTypeStrategy(
        finalItems,
        config,
        plexClient,
        allCollections,
        processedCollectionKeys,
        undefined, // userInfo
        libraryCache,
        missingItems
      );
    } catch (error) {
      // Log detailed error information before rethrowing
      logger.error(`Detailed MDBList collection error for "${config.name}"`, {
        label: 'MDBList Collections',
        configId: config.id,
        configName: config.name,
        subtype: config.subtype,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        errorType:
          error instanceof Error ? error.constructor.name : typeof error,
        fullError: JSON.stringify(error, Object.getOwnPropertyNames(error)),
        errorProperties: Object.getOwnPropertyNames(error),
      });

      throw this.createSyncError(
        CollectionSyncErrorType.COLLECTION_ERROR,
        `Failed to process MDBList collection ${config.name}`,
        { configId: config.id, configName: config.name },
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * Create template context for MDBList collections
   */
  protected async createTemplateContext(
    config: CollectionConfig,
    mediaType: 'movie' | 'tv'
  ): Promise<MDBListTemplateContext> {
    return this.templateEngine.createMDBListContext(
      mediaType,
      'custom'
    ) as MDBListTemplateContext;
  }

  /**
   * Fetch data from MDBList API
   */
  public async fetchSourceData(
    config: CollectionConfig,
    options?: CollectionSyncOptions,
    libraryCache?: LibraryItemsCache // eslint-disable-line @typescript-eslint/no-unused-vars
  ): Promise<MDBListSourceData[]> {
    const settings = getSettings();
    const apiKey = settings.mdblist.apiKey;
    if (!apiKey) {
      throw this.createSyncError(
        CollectionSyncErrorType.CONFIGURATION_ERROR,
        'MDBList API key not configured'
      );
    }
    const sessionCookie = settings.mdblist.sessionCookie;
    const mdblistClient = this.getMDBListClient(apiKey, sessionCookie);
    const listType = this.getListTypeFromSubtype(config.subtype);

    const mdblistData: MDBListSourceData[] = [];

    if (options?.apiTimeout) {
      logger.debug(`API timeout set to ${options.apiTimeout}ms`, {
        label: 'MDBList Collections',
      });
    }

    const mediaType = getCollectionMediaType(config);

    try {
      if (listType !== 'custom' && listType !== 'search') {
        throw this.createSyncError(
          CollectionSyncErrorType.CONFIGURATION_ERROR,
          `MDBList only supports custom and search lists. Invalid subtype: ${config.subtype}`
        );
      }

      if (!config.mdblistCustomListUrl) {
        throw this.createSyncError(
          CollectionSyncErrorType.CONFIGURATION_ERROR,
          'Custom MDBList list URL is required'
        );
      }

      // Search lists require query parameters; standard custom lists strip them.
      const cleanUrl =
        config.subtype === 'search'
          ? config.mdblistCustomListUrl
          : config.mdblistCustomListUrl?.split('?')[0] ||
            config.mdblistCustomListUrl;

      const limit = 1000;
      let offset = 0;
      let hasMore = true;
      let pageCount = 0;

      while (hasMore) {
        pageCount++;
        logger.debug(
          `Fetching MDBList page ${pageCount} (offset: ${offset}, limit: ${limit})`,
          { label: 'MDBList Collections' }
        );

        const customListData: MDBListResponse =
          await mdblistClient.getCustomList(cleanUrl, { limit, offset });

        const movieCount = customListData.movies?.length ?? 0;
        const showCount = customListData.shows?.length ?? 0;
        const totalFetched = movieCount + showCount;

        // Convert to standardized format
        const targetItems: (MDBListMovie | MDBListShow)[] =
          mediaType === 'movie' ? customListData.movies : customListData.shows;

        if (targetItems && targetItems.length > 0) {
          mdblistData.push(...targetItems.map((item) => ({ item, mediaType })));
        }

        // Fewer results than the limit means we've reached the last page.
        if (totalFetched < limit) {
          hasMore = false;
        } else {
          offset += limit;
        }

        // Safety break to prevent infinite loops on unexpected API behaviour.
        if (pageCount > 100) {
          logger.warn('MDBList pagination forced break after 100 pages', {
            label: 'MDBList Collections',
          });
          break;
        }
      }

      return mdblistData;
    } catch (error) {
      // Extract a meaningful error message
      let errorMessage: string;
      let originalError: Error;

      if (error instanceof Error) {
        errorMessage = error.message;
        originalError = error;
      } else if (
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof (error as { message: unknown }).message === 'string'
      ) {
        errorMessage = (error as { message: string }).message;
        originalError = new Error(errorMessage);
      } else if (typeof error === 'object' && error !== null) {
        // Try to serialize the error object
        try {
          errorMessage = JSON.stringify(error);
          originalError = new Error(errorMessage);
        } catch {
          errorMessage = 'Unknown error (could not serialize error object)';
          originalError = new Error(errorMessage);
        }
      } else {
        errorMessage = String(error);
        originalError = new Error(errorMessage);
      }

      logger.error(`MDBList API error: ${errorMessage}`, {
        label: 'MDBList Collections',
        listType,
        mediaType,
        url: config.mdblistCustomListUrl,
        errorType:
          error instanceof Error ? error.constructor.name : typeof error,
      });

      throw this.createSyncError(
        CollectionSyncErrorType.API_ERROR,
        `Failed to fetch data from MDBList API`,
        { listType, mediaType },
        originalError
      );
    }
  }

  /**
   * Map MDBList source data to standardized collection items
   */
  public async mapSourceDataToItems(
    sourceData: MDBListSourceData[],
    config: CollectionConfig,
    plexClient?: PlexAPI,
    libraryCache?: LibraryItemsCache
  ): Promise<{
    items: MDBListCollectionItem[];
    missingItems?: MissingItem[];
    stats?: FilteringStats;
  }> {
    const mappedItems: MDBListCollectionItem[] = [];
    const missingItems: MissingItem[] = [];

    // Extract all TMDB IDs and prepare lookup data
    const mdblistLookups: {
      tmdbId: number;
      imdbId?: string;
      mediaType: 'movie' | 'tv';
      title: string;
      year?: number;
      originalPosition: number;
    }[] = [];

    for (let index = 0; index < sourceData.length; index++) {
      const sourceItem = sourceData[index];
      try {
        // MDBList items have id (TMDB ID), imdb_id, title, and mediatype.
        // Scraped search items have id=0 but a valid imdb_id.
        const item = sourceItem.item;

        // Skip only if we have neither a TMDB ID nor an IMDB ID.
        if (!item.id && !item.imdb_id) {
          continue;
        }

        // Convert mediatype from 'show' to 'tv' for consistency
        const itemMediaType = item.mediatype === 'show' ? 'tv' : item.mediatype;

        mdblistLookups.push({
          tmdbId: item.id,
          imdbId: item.imdb_id || undefined,
          mediaType: itemMediaType as 'movie' | 'tv',
          title: item.title,
          year: item.release_year,
          originalPosition: index + 1,
        });
      } catch (error) {
        logger.warn(`Failed to process MDBList item: ${error}`, {
          label: 'MDBList Collections',
        });
      }
    }

    logger.info(
      `Extracted ${mdblistLookups.length} TMDB IDs from ${sourceData.length} MDBList items`,
      {
        label: 'MDBList Collections',
        sampleIds: mdblistLookups.slice(0, 5).map((l) => ({
          tmdbId: l.tmdbId,
          title: l.title,
          mediaType: l.mediaType,
        })),
      }
    );

    if (mdblistLookups.length === 0) {
      const stats = this.createFilteringStats(sourceData.length, 0, {
        'invalid data': sourceData.length,
      });
      return { items: mappedItems, missingItems, stats };
    }

    // Use direct Plex queries instead of Media table
    let plexLookup: Map<string, PlexLookupResult> = new Map();

    const targetLibraryId = Array.isArray(config.libraryId)
      ? config.libraryId[0]
      : config.libraryId;

    if (plexClient) {
      plexLookup = await findPlexItemsByTmdbIds(
        plexClient,
        mdblistLookups,
        targetLibraryId,
        libraryCache,
        false // Library-scoped search for collection creation
      );
    } else {
      logger.warn('No Plex client provided to mapSourceDataToItems', {
        label: 'MDBList Collections',
      });
    }

    // Build an IMDB → Plex item map for items that have tmdbId=0 (scraped search results).
    // We do this lazily — only when at least one lookup item actually needs it.
    const needsImdbFallback = mdblistLookups.some(
      (l) => l.tmdbId === 0 && l.imdbId
    );

    const imdbLookup = new Map<string, PlexLookupResult>();

    if (needsImdbFallback && libraryCache) {
      for (const [libraryKey, items] of Object.entries(libraryCache)) {
        if (targetLibraryId && libraryKey !== targetLibraryId) continue;

        for (const item of items as {
          ratingKey: string;
          title: string;
          addedAt?: number;
          originallyAvailableAt?: string;
          Guid?: { id?: string }[];
        }[]) {
          if (!item.Guid) continue;
          for (const guid of item.Guid) {
            const match = guid.id?.match(/imdb:\/\/(tt\d+)/);
            if (match) {
              imdbLookup.set(match[1], {
                ratingKey: item.ratingKey,
                title: item.title,
                libraryKey,
                addedAt: item.addedAt,
                releaseDate: item.originallyAvailableAt
                  ? new Date(item.originallyAvailableAt).getTime()
                  : undefined,
              });
            }
          }
        }
      }

      logger.debug(`Built IMDB lookup map with ${imdbLookup.size} entries`, {
        label: 'MDBList Collections',
      });
    }

    // Process items using the Plex lookup map (with IMDB fallback for search items).
    for (const lookup of mdblistLookups) {
      let plexItem: PlexLookupResult | undefined;

      // Primary: TMDB lookup.
      if (lookup.tmdbId > 0) {
        plexItem = plexLookup.get(`${lookup.tmdbId}-${lookup.mediaType}`);
      }

      // Fallback: IMDB lookup for scraped items where TMDB ID is unavailable.
      if (!plexItem && lookup.imdbId) {
        plexItem = imdbLookup.get(lookup.imdbId);
      }

      if (plexItem) {
        const mappedItem = {
          ratingKey: plexItem.ratingKey,
          title: plexItem.title,
          type: lookup.mediaType,
          tmdbId: lookup.tmdbId,
          tvdbId: plexItem.tvdbId,
          addedAt: plexItem.addedAt,
          releaseDate: plexItem.releaseDate,
          metadata: {
            libraryKey: plexItem.libraryKey,
            originalPosition: lookup.originalPosition,
          },
        };

        mappedItems.push(mappedItem);
      } else {
        // Item exists in MDBList but not in Plex
        missingItems.push({
          tmdbId: lookup.tmdbId,
          mediaType: lookup.mediaType,
          title: lookup.title,
          year: lookup.year,
          originalPosition: lookup.originalPosition,
          source: this.source,
        });
      }
    }

    const stats = this.createFilteringStats(
      sourceData.length,
      mappedItems.length,
      {
        'missing from plex': missingItems.length,
        'invalid data': sourceData.length - mdblistLookups.length,
      }
    );

    return {
      items: mappedItems,
      missingItems,
      stats,
    };
  }

  /**
   * Create collection in Plex
   */
  protected async createCollection(
    items: CollectionItem[],
    mediaType: 'movie' | 'tv',
    collectionName: string,
    plexClient: PlexAPI,
    allCollections: PlexCollection[],
    config: CollectionConfig,
    processedCollectionKeys?: Set<string>
  ): Promise<CollectionOperationResult> {
    try {
      // Use the new standardized approach via BaseCollectionSync
      const result = await this.createOrUpdateCollectionStandardized(
        items,
        collectionName,
        mediaType,
        config,
        plexClient,
        allCollections,
        processedCollectionKeys
      );

      // Update config with rating key if we got one
      this.updateConfigWithRatingKey(config, result.collectionRatingKey);

      return {
        created: result.created,
        updated: result.updated,
        collectionRatingKey: result.collectionRatingKey,
        itemCount: result.itemCount || items.length,
        stats: result.stats,
      };
    } catch (error) {
      throw this.createSyncError(
        CollectionSyncErrorType.COLLECTION_ERROR,
        `Failed to create MDBList collection ${collectionName}`,
        { collectionName, itemCount: items.length },
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  // Private helper methods

  private getMDBListClient(apiKey: string, sessionCookie?: string): MDBListAPI {
    const cacheKey = sessionCookie ? `${apiKey}:${sessionCookie}` : apiKey;
    if (!this.mdblistClients.has(cacheKey)) {
      this.mdblistClients.set(cacheKey, new MDBListAPI(apiKey, sessionCookie));
    }
    const client = this.mdblistClients.get(cacheKey);
    if (!client) {
      throw new Error(`Failed to get MDBList client for API key`);
    }
    return client;
  }

  private isValidMDBListConfig(config: CollectionConfig): boolean {
    if (config.type !== 'mdblist' || !config.subtype) {
      return false;
    }

    // Only custom lists are supported
    // Custom and Search subtypes are both supported
    return config.subtype === 'custom' || config.subtype === 'search';
  }

  private getListTypeFromSubtype(subtype: string | undefined): string {
    if (!subtype) return 'custom';
    if (subtype === 'search') return 'search';
    return 'custom';
  }

  private async handleAutoRequests(
    missingItems: MissingItem[],
    config: CollectionConfig
  ): Promise<void> {
    // Use the unified download service (routes to Overseerr or direct *arr based on config)
    await processMissingItemsWithMode(missingItems, config, 'mdblist');
  }
}

export default MDBListCollectionSync;
