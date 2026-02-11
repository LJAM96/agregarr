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
    const mdblistClient = this.getMDBListClient(apiKey);
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

      // Strip query parameters from URL ONLY for standard custom lists
      // Search lists require query parameters
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
          {
            label: 'MDBList Collections',
          }
        );

        const customListData: MDBListResponse =
          await mdblistClient.getCustomList(cleanUrl, {
            limit,
            offset,
          });

        const movieCount = customListData.movies?.length || 0;
        const showCount = customListData.shows?.length || 0;
        const totalFetched = movieCount + showCount;

        // Convert to standardized format
        const targetItems: (MDBListMovie | MDBListShow)[] =
          mediaType === 'movie' ? customListData.movies : customListData.shows;

        if (targetItems && targetItems.length > 0) {
          mdblistData.push(...targetItems.map((item) => ({ item, mediaType })));
        }

        // Check if we reached the end
        // If we fetched fewer items than the limit, we're done
        if (totalFetched < limit) {
          hasMore = false;
        } else {
          offset += limit;
        }

        // Safety break to prevent infinite loops in case of API weirdness
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
        // MDBList items have id (TMDB ID), imdb_id, title, and mediatype
        const item = sourceItem.item;

        // Skip only if we have neither TMDB ID nor IMDB ID
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
          originalPosition: index + 1, // 1-based position
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

    if (plexClient) {
      // Pass target library ID to limit search scope to only the collection's target library
      const targetLibraryId = Array.isArray(config.libraryId)
        ? config.libraryId[0]
        : config.libraryId;
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

    // Build IMDB lookup map from libraryCache for items with tmdbId=0
    const imdbLookup: Map<
      string,
      {
        ratingKey: string;
        title: string;
        libraryKey: string;
        addedAt?: number;
        releaseDate?: number;
      }
    > = new Map();

    if (libraryCache) {
      const targetLibraryId = Array.isArray(config.libraryId)
        ? config.libraryId[0]
        : config.libraryId;

      // Build IMDB lookup from cached library items
      for (const [libraryKey, items] of Object.entries(libraryCache)) {
        // Only check target library for collection creation
        if (targetLibraryId && libraryKey !== targetLibraryId) {
          continue;
        }

        for (const item of items) {
          // Cast to any to access originallyAvailableAt which is present in library items but not in all item types
          const anyItem = item as any;
          if (anyItem.Guid) {
            for (const guid of anyItem.Guid) {
              // Match IMDB GUIDs like "imdb://tt1234567"
              const imdbMatch = guid.id?.match(/imdb:\/\/(tt\d+)/);
              if (imdbMatch) {
                imdbLookup.set(imdbMatch[1], {
                  ratingKey: anyItem.ratingKey,
                  title: anyItem.title,
                  libraryKey,
                  addedAt: anyItem.addedAt,
                  releaseDate: anyItem.originallyAvailableAt
                    ? new Date(anyItem.originallyAvailableAt).getTime()
                    : undefined,
                });
              }
            }
          }
        }
      }
      logger.debug(`Built IMDB lookup map with ${imdbLookup.size} entries`, {
        label: 'MDBList Collections',
      });
    }

    // Process items using the Plex lookup map
    for (const lookup of mdblistLookups) {
      let plexItem:
        | {
            ratingKey: string;
            title: string;
            libraryKey: string;
            addedAt?: number;
            releaseDate?: number;
          }
        | undefined;

      // First try TMDB lookup (for items with valid TMDB ID)
      if (lookup.tmdbId > 0) {
        const key = `${lookup.tmdbId}-${lookup.mediaType}`;
        plexItem = plexLookup.get(key);
      }

      // Fallback to IMDB lookup for items with tmdbId=0
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
            originalPosition: lookup.originalPosition, // CRITICAL: Preserve source order for multi-source interleaving
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

  private getMDBListClient(apiKey: string): MDBListAPI {
    if (!this.mdblistClients.has(apiKey)) {
      this.mdblistClients.set(apiKey, new MDBListAPI(apiKey));
    }
    const client = this.mdblistClients.get(apiKey);
    if (!client) {
      throw new Error(`Failed to get MDBList client for API key`);
    }
    return client;
  }

  private isValidMDBListConfig(config: CollectionConfig): boolean {
    if (config.type !== 'mdblist' || !config.subtype) {
      return false;
    }

    // Custom and Search lists are supported
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
