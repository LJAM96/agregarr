/**
 * Edition Manager Job
 *
 * Iterates Plex movie libraries (type=1) and TV show libraries (type=2,
 * show-level only) and writes an `editionTitle` field based on the enabled
 * and ordered set of metadata modules.
 *
 * Movies use per-file Media streams. Shows have no show-level Media, so
 * technical modules are aggregated from sampled episodes, then written once
 * to the show object.
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

export type EditionManagerScope = 'all' | 'movies' | 'shows';

export interface TvPreviewItem {
  ratingKey: string;
  title: string;
  year?: number;
  currentEdition?: string;
  previewEdition: string | null;
  error?: string;
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

  public async run(
    mode: 'full' | 'incremental' = 'full',
    scope: EditionManagerScope = 'all'
  ): Promise<void> {
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

    logger.info(`Edition Manager started (mode: ${mode}, scope: ${scope})`, { label: 'Edition Manager' });

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
      const showLibraries = libraries.filter((l) => l.type === 'show');

      const tvEnabled = emSettings.tvEnabled !== false;
      const tvModules = emSettings.tvEnabledModules ?? ['Resolution', 'Source'];
      const tvSeparator = emSettings.tvSeparator ?? emSettings.separator ?? ' · ';

      logger.info(
        `Found ${movieLibraries.length} movie library(s), ${showLibraries.length} show library(s) (TV ${tvEnabled ? 'enabled' : 'disabled'})`,
        {
          label: 'Edition Manager',
        }
      );

      // First pass: count total movies (+ shows if TV enabled)
      // Scoped runs skip the excluded media type entirely.
      const runMovies = scope !== 'shows';
      const runShows =
        scope !== 'movies' && tvEnabled && tvModules.length > 0;

      if (runMovies) {
        for (const lib of movieLibraries) {
          if (this.cancelled) break;
          const { totalSize } = await plexClient.getLibraryContents(lib.key, {
            offset: 0,
            size: 1,
          });
          this.status.total += totalSize;
        }
      }

      if (runShows) {
        for (const lib of showLibraries) {
          if (this.cancelled) break;
          const { totalSize } = await plexClient.getLibraryContents(lib.key, {
            offset: 0,
            size: 1,
          });
          this.status.total += totalSize;
        }
      }

      // Second pass: process each movie
      if (runMovies) {
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
      }

      // Second pass (TV): process each show at show-level (type=2)
      if (runShows) {
        for (const lib of showLibraries) {
          if (this.cancelled) break;

          this.status.currentLibrary = lib.title;
          logger.info(`Processing TV library: ${lib.title}`, {
            label: 'Edition Manager',
          });

          const PAGE_SIZE = 50;
          let offset = 0;
          let fetched = 0;
          let libTotal = 0;

          do {
            if (this.cancelled) break;

            const { totalSize, items } = await plexClient.getLibraryContents(
              lib.key,
              {
                offset,
                size: PAGE_SIZE,
              }
            );
            libTotal = totalSize;

            for (const item of items) {
              if (this.cancelled) break;

              try {
                if (mode === 'incremental' && item.editionTitle) {
                  this.status.skipped++;
                  this.status.processed++;
                  logger.debug(
                    `Skipping show '${item.title}' — edition already set: '${item.editionTitle}'`,
                    { label: 'Edition Manager' }
                  );
                  continue;
                }

                const showData = (await plexClient.getMovieFullMetadata(
                  item.ratingKey
                )) as PlexMovieData;

                const episodeSamples = await this.getTvEpisodeSamples(
                  plexClient,
                  item.ratingKey
                );

                const editionTitle = await this.buildTvEditionTitle(
                  showData,
                  episodeSamples,
                  {
                    enabledModules: tvModules,
                    separator: tvSeparator,
                    ratingSource: emSettings.ratingSource,
                    ratingRottenTomatoesType:
                      emSettings.ratingRottenTomatoesType,
                    languageExcluded: emSettings.languageExcluded,
                    languageSkipMultiple: emSettings.languageSkipMultiple,
                  }
                );

                if (editionTitle !== null) {
                  await plexClient.setShowEditionTitle(
                    item.ratingKey,
                    editionTitle
                  );
                  this.status.updated++;

                  logger.debug(
                    `Set TV edition '${editionTitle}' on show '${showData.title ?? item.ratingKey}'`,
                    { label: 'Edition Manager' }
                  );
                } else {
                  this.status.skipped++;
                }

                this.status.processed++;
              } catch (err) {
                this.status.failed++;
                logger.error(
                  `Failed to process show ${item.ratingKey}: ${
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

  /**
   * Read-only TV preview: build (but do not write) show-level editions for a
   * small sample of shows using the saved TV settings. Used by the settings
   * GUI to verify the TV path before running a full job.
   */
  public async previewTvShows(
    limit = 5,
    title?: string
  ): Promise<TvPreviewItem[]> {
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

    const tvModules = emSettings.tvEnabledModules ?? ['Resolution', 'Source'];
    const tvSeparator = emSettings.tvSeparator ?? emSettings.separator ?? ' · ';

    const libraries = await plexClient.getLibraries();
    const showLibraries = libraries.filter((l) => l.type === 'show');
    if (!showLibraries.length) throw new Error('No TV library found');

    // Page all show libraries until we have `limit` candidates (or exhaust them).
    const candidates: { ratingKey: string; title: string; year?: number; editionTitle?: string }[] = [];
    const PAGE_SIZE = 100;
    for (const showLibrary of showLibraries) {
      if (candidates.length >= limit) break;
      let offset = 0;
      for (let page = 0; page < 200; page++) {
        const { totalSize, items } = await plexClient.getLibraryContents(
          showLibrary.key,
          { offset, size: PAGE_SIZE }
        );
        for (const item of items) {
          if (
            !title ||
            item.title.toLowerCase().includes(title.toLowerCase())
          ) {
            candidates.push({
              ratingKey: item.ratingKey,
              title: item.title,
              year: item.year,
              editionTitle: item.editionTitle,
            });
            if (candidates.length >= limit) break;
          }
        }
        if (candidates.length >= limit || offset + items.length >= totalSize) break;
        offset += PAGE_SIZE;
      }
    }

    const results: TvPreviewItem[] = [];
    for (const candidate of candidates) {
      try {
        const showData = (await plexClient.getMovieFullMetadata(
          candidate.ratingKey
        )) as PlexMovieData;
        const episodeSamples = await this.getTvEpisodeSamples(
          plexClient,
          candidate.ratingKey
        );
        const previewEdition = await this.buildTvEditionTitle(
          showData,
          episodeSamples,
          {
            enabledModules: tvModules,
            separator: tvSeparator,
            ratingSource: emSettings.ratingSource,
            ratingRottenTomatoesType: emSettings.ratingRottenTomatoesType,
            languageExcluded: emSettings.languageExcluded,
            languageSkipMultiple: emSettings.languageSkipMultiple,
          }
        );
        results.push({
          ratingKey: candidate.ratingKey,
          title: candidate.title,
          year: candidate.year,
          currentEdition: candidate.editionTitle,
          previewEdition,
        });
      } catch (err) {
        results.push({
          ratingKey: candidate.ratingKey,
          title: candidate.title,
          year: candidate.year,
          currentEdition: candidate.editionTitle,
          previewEdition: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
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
      const value = await this.getModuleValue(data, mod, settings);

      if (value) parts.push(value);
    }

    return parts.length ? parts.join(settings.separator) : null;
  }

  private async getModuleValue(
    data: PlexMovieData,
    mod: string,
    settings: {
      ratingSource: 'imdb' | 'rotten_tomatoes' | 'letterboxd';
      ratingRottenTomatoesType: 'critic' | 'audience';
      languageExcluded: string[];
      languageSkipMultiple: boolean;
    }
  ): Promise<string | null> {
    switch (mod) {
      case 'Resolution':
        return getResolution(data);
      case 'DynamicRange':
        return getDynamicRange(data);
      case 'AudioCodec':
        return getAudioCodec(data);
      case 'VideoCodec':
        return getVideoCodec(data);
      case 'Source':
        return getSource(data);
      case 'Cut':
        return getCut(data);
      case 'Release':
        return getRelease(data);
      case 'AudioChannels':
        return getAudioChannels(data);
      case 'Bitrate':
        return getBitrate(data);
      case 'Language':
        return getLanguage(data, {
          excludedLanguages: settings.languageExcluded,
          skipMultipleAudioTracks: settings.languageSkipMultiple,
        });
      case 'Rating':
        return this.getRatingValue(
          data,
          settings.ratingSource,
          settings.ratingRottenTomatoesType
        );
      case 'Size':
        return getSize(data);
      case 'ContentRating':
        return getContentRating(data);
      case 'Director':
        return getDirector(data);
      case 'Duration':
        return getDuration(data);
      case 'FrameRate':
        return getFrameRate(data);
      case 'Genre':
        return getGenre(data);
      case 'Country':
        return getCountry(data);
      case 'ShortFilm':
        return getShortFilm(data);
      case 'Studio':
        return getStudio(data);
      case 'Writer':
        return getWriter(data);
      // SpecialFeatures requires an extra API call — skipped for now
      case 'SpecialFeatures':
      default:
        return null;
    }
  }

  /**
   * Sample the first episode of each season (up to maxSamples) so each
   * season gets equal weight. Only single-season shows fill remaining slots
   * from S01. Returns full metadata objects for aggregation.
   */
  private async getTvEpisodeSamples(
    plexClient: {
      getChildrenMetadata: (key: string) => Promise<{ ratingKey: string; type?: string; index?: number }[]>;
      getMovieFullMetadata: (key: string) => Promise<Record<string, unknown>>;
    },
    showRatingKey: string,
    maxSamples = 5
  ): Promise<PlexMovieData[]> {
    const seasons = await plexClient.getChildrenMetadata(showRatingKey);
    const seasonKeys = seasons
      .filter((s) => s.type === 'season')
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((s) => s.ratingKey);

    const candidateKeys: string[] = [];
    const perSeasonFirst: string[][] = [];

    for (const seasonKey of seasonKeys) {
      try {
        const episodes = await plexClient.getChildrenMetadata(seasonKey);
        const epKeys = episodes
          .filter((e) => e.type === 'episode')
          .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
          .map((e) => e.ratingKey);
        perSeasonFirst.push(epKeys);
      } catch {
        continue;
      }
    }

    // First episode of each season only (equal weight per season)
    for (const epKeys of perSeasonFirst) {
      if (epKeys[0] && candidateKeys.length < maxSamples) {
        candidateKeys.push(epKeys[0]);
      }
    }
    // Single-season shows only: fill remaining slots from S01 in order
    if (perSeasonFirst.length === 1 && candidateKeys.length < maxSamples) {
      const onlySeason = perSeasonFirst[0];
      for (
        let i = 1;
        i < onlySeason.length && candidateKeys.length < maxSamples;
        i++
      ) {
        if (!candidateKeys.includes(onlySeason[i]))
          candidateKeys.push(onlySeason[i]);
      }
    }

    const samples: PlexMovieData[] = [];
    for (const key of candidateKeys.slice(0, maxSamples)) {
      try {
        const full = (await plexClient.getMovieFullMetadata(
          key
        )) as PlexMovieData;
        samples.push(full);
      } catch {
        continue;
      }
    }
    return samples;
  }

  /**
   * Build a show-level edition title. Show-level fields (Genre, Studio, …)
   * come from the show object; technical fields are majority-voted across
   * sampled episodes. Mixed values are joined with ' / ' (e.g. mixed
   * resolutions). Size/Bitrate vary per episode so they are skipped for TV
   * unless every sample agrees.
   */
  private async buildTvEditionTitle(
    showData: PlexMovieData,
    episodeSamples: PlexMovieData[],
    settings: {
      enabledModules: string[];
      separator: string;
      ratingSource: 'imdb' | 'rotten_tomatoes' | 'letterboxd';
      ratingRottenTomatoesType: 'critic' | 'audience';
      languageExcluded: string[];
      languageSkipMultiple: boolean;
    }
  ): Promise<string | null> {
    const SHOW_LEVEL = new Set([
      'ContentRating',
      'Genre',
      'Country',
      'Studio',
      'Director',
      'Writer',
      'Rating',
    ]);
    const SKIP_FOR_TV = new Set(['Size', 'Bitrate', 'Duration', 'ShortFilm']);

    const parts: string[] = [];

    for (const mod of settings.enabledModules) {
      if (SKIP_FOR_TV.has(mod)) {
        continue;
      }

      if (SHOW_LEVEL.has(mod)) {
        const value = await this.getModuleValue(showData, mod, settings);
        if (value) parts.push(value);
        continue;
      }

      if (!episodeSamples.length) continue;

      const values = (
        await Promise.all(
          episodeSamples.map((ep) => this.getModuleValue(ep, mod, settings))
        )
      ).filter((v): v is string => !!v);

      if (!values.length) continue;

      const counts = new Map<string, number>();
      for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
      const topCount = Math.max(...counts.values());
      const winners = [...counts.entries()]
        .filter(([, c]) => c === topCount)
        .map(([v]) => v)
        .sort();

      // Unanimous (or single sample) → single value; mixed → join distinct
      // in first-seen order so e.g. '1080p / 4K' is transparent.
      if (winners.length === 1) {
        parts.push(winners[0]);
      } else {
        const seen: string[] = [];
        for (const v of values) {
          if (winners.includes(v) && !seen.includes(v)) seen.push(v);
        }
        parts.push(seen.join(' / '));
      }
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
