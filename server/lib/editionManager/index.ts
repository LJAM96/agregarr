/**
 * Edition Manager Job
 *
 * Iterates all Plex movie libraries and writes an `editionTitle` field for
 * each movie based on the enabled and ordered set of metadata modules.
 *
 * Ported from LJAM96/edition-manager (Python).
 */

import logger from '@server/logger';
import type { PlexMovieData } from './modules';
import {
  getAudioChannels,
  getAudioCodec,
  getBitrate,
  getContentRating,
  getCountry,
  getCut,
  getDirector,
  getDuration,
  getDynamicRange,
  getFrameRate,
  getGenre,
  getLanguage,
  getRelease,
  getResolution,
  getShortFilm,
  getSize,
  getSource,
  getStudio,
  getVideoCodec,
  getWriter,
} from './modules';

export interface EditionManagerStatus {
  running: boolean;
  cancelled: boolean;
  total: number;
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
  currentLibrary: string;
}

class EditionManager {
  private cancelled = false;

  public status: EditionManagerStatus = {
    running: false,
    cancelled: false,
    total: 0,
    processed: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    currentLibrary: '',
  };

  public async run(mode: 'full' | 'incremental' = 'full'): Promise<void> {
    if (this.status.running) {
      logger.warn('Edition Manager already running', { label: 'Edition Manager' });
      return;
    }

    this.status = {
      running: true,
      cancelled: false,
      total: 0,
      processed: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      currentLibrary: '',
    };
    this.cancelled = false;

    logger.info(`Edition Manager started (mode: ${mode})`, { label: 'Edition Manager' });

    try {
      const { getAdminUser } = await import(
        '@server/lib/collections/core/CollectionUtilities'
      );
      const PlexAPI = (await import('@server/api/plexapi')).default;
      const { getSettings } = await import('@server/lib/settings');

      const admin = await getAdminUser();
      if (!admin?.plexToken) throw new Error('No local admin Plex token found');

      const settings = getSettings();
      const emSettings = settings.editionManager;
      const plexClient = new PlexAPI({
        plexToken: admin.plexToken,
        plexSettings: settings.plex,
      });

      const libraries = await plexClient.getLibraries();
      const movieLibraries = libraries.filter((l) => l.type === 'movie');

      logger.info(`Found ${movieLibraries.length} movie library(s)`, {
        label: 'Edition Manager',
      });

      // First pass: count total movies
      for (const lib of movieLibraries) {
        if (this.cancelled) break;
        const { totalSize } = await plexClient.getLibraryContents(lib.key, {
          offset: 0,
          size: 1,
        });
        this.status.total += totalSize;
      }

      // Second pass: process each movie
      for (const lib of movieLibraries) {
        if (this.cancelled) break;

        this.status.currentLibrary = lib.title;
        logger.info(`Processing library: ${lib.title}`, { label: 'Edition Manager' });

        const PAGE_SIZE = 100;
        let offset = 0;
        let fetched = 0;
        let libTotal = 0;

        do {
          if (this.cancelled) break;

          const { totalSize, items } = await plexClient.getLibraryContents(lib.key, {
            offset,
            size: PAGE_SIZE,
          });
          libTotal = totalSize;

          for (const item of items) {
            if (this.cancelled) break;

            try {
              // In incremental mode, skip movies that already have an edition set.
              // editionTitle is returned by the listing endpoint so we avoid an
              // extra per-movie metadata fetch for these.
              if (mode === 'incremental' && item.editionTitle) {
                this.status.skipped++;
                this.status.processed++;
                logger.debug(
                  `Skipping '${item.title}' — edition already set: '${item.editionTitle}'`,
                  { label: 'Edition Manager' }
                );
                continue;
              }

              const movieData = (await plexClient.getMovieFullMetadata(
                item.ratingKey
              )) as PlexMovieData;

              const editionTitle = await this.buildEditionTitle(
                movieData,
                emSettings
              );

              if (editionTitle !== null) {
                await plexClient.setMovieEditionTitle(item.ratingKey, editionTitle);
                this.status.updated++;

                logger.debug(
                  `Set edition '${editionTitle}' on '${movieData.title ?? item.ratingKey}'`,
                  { label: 'Edition Manager' }
                );
              } else {
                this.status.skipped++;
              }

              this.status.processed++;
            } catch (err) {
              this.status.failed++;
              logger.error(
                `Failed to process movie ${item.ratingKey}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
                { label: 'Edition Manager' }
              );
            }
          }

          fetched += items.length;
          offset += PAGE_SIZE;
        } while (fetched < libTotal);
      }

      logger.info(
        `Edition Manager complete — updated: ${this.status.updated}, skipped: ${this.status.skipped}, failed: ${this.status.failed}`,
        { label: 'Edition Manager' }
      );
    } catch (error) {
      logger.error('Edition Manager failed', {
        label: 'Edition Manager',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.status.running = false;
      this.status.currentLibrary = '';
    }
  }

  public cancel(): void {
    logger.info('Cancelling Edition Manager', { label: 'Edition Manager' });
    this.cancelled = true;
  }

  private async buildEditionTitle(
    data: PlexMovieData,
    settings: {
      enabledModules: string[];
      separator: string;
      ratingSource: 'imdb' | 'rotten_tomatoes' | 'letterboxd';
      ratingRottenTomatoesType: 'critic' | 'audience';
      languageExcluded: string[];
      languageSkipMultiple: boolean;
    }
  ): Promise<string | null> {
    const parts: string[] = [];

    for (const mod of settings.enabledModules) {
      let value: string | null = null;

      switch (mod) {
        case 'Resolution':
          value = getResolution(data);
          break;
        case 'DynamicRange':
          value = getDynamicRange(data);
          break;
        case 'AudioCodec':
          value = getAudioCodec(data);
          break;
        case 'VideoCodec':
          value = getVideoCodec(data);
          break;
        case 'Source':
          value = getSource(data);
          break;
        case 'Cut':
          value = getCut(data);
          break;
        case 'Release':
          value = getRelease(data);
          break;
        case 'AudioChannels':
          value = getAudioChannels(data);
          break;
        case 'Bitrate':
          value = getBitrate(data);
          break;
        case 'Language':
          value = getLanguage(data, {
            excludedLanguages: settings.languageExcluded,
            skipMultipleAudioTracks: settings.languageSkipMultiple,
          });
          break;
        case 'Rating':
          // Use the app's built-in TMDb client for IMDb ratings;
          // Rotten Tomatoes uses Plex's own audienceRating/rating fields.
          value = await this.getRatingValue(
            data,
            settings.ratingSource,
            settings.ratingRottenTomatoesType
          );
          break;
        case 'Size':
          value = getSize(data);
          break;
        case 'ContentRating':
          value = getContentRating(data);
          break;
        case 'Director':
          value = getDirector(data);
          break;
        case 'Duration':
          value = getDuration(data);
          break;
        case 'FrameRate':
          value = getFrameRate(data);
          break;
        case 'Genre':
          value = getGenre(data);
          break;
        case 'Country':
          value = getCountry(data);
          break;
        case 'ShortFilm':
          value = getShortFilm(data);
          break;
        case 'Studio':
          value = getStudio(data);
          break;
        case 'Writer':
          value = getWriter(data);
          break;
        // SpecialFeatures requires an extra API call — skipped for now
        case 'SpecialFeatures':
          break;
      }

      if (value) parts.push(value);
    }

    return parts.length ? parts.join(settings.separator) : null;
  }

  private async getRatingValue(
    data: PlexMovieData,
    source: 'imdb' | 'rotten_tomatoes' | 'letterboxd',
    rtType: 'critic' | 'audience'
  ): Promise<string | null> {
    if (source === 'rotten_tomatoes') {
      const val = rtType === 'audience' ? data.audienceRating : data.rating;
      if (!val) return null;
      return `${Math.round(val * 10)}%`;
    }

    if (source === 'imdb') {
      try {
        const TheMovieDb = (await import('@server/api/themoviedb')).default;
        const tmdb = new TheMovieDb();
        const results = await tmdb.searchMovies({
          query: data.title ?? '',
          year: data.year,
        });
        const movie = results.results?.[0];
        if (!movie?.vote_average) return null;
        return `IMDb ${movie.vote_average.toFixed(1)}`;
      } catch {
        return null;
      }
    }

    return null;
  }
}

const editionManager = new EditionManager();
export default editionManager;
