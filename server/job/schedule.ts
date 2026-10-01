// Availability sync import removed - not needed for collections-only app
import collectionsQuickSync from '@server/lib/collectionsQuickSync';
import collectionsSync from '@server/lib/collectionsSync';
// ImageProxy removed - not needed for collections-only app
import deleteUnlabelledCollections from '@server/lib/deleteUnlabelledCollections';
import editionManager from '@server/lib/editionManager';
import overlayApplication from '@server/lib/overlayApplication';
import overlaysQuickSync from '@server/lib/overlaysQuickSync';
import randomizeHomeOrder from '@server/lib/randomizeHomeOrder';
import refreshToken from '@server/lib/refreshToken';
import watchlistSync from '@server/lib/watchlistSync';
// Scanner imports removed - not needed for collections-only app
import type { JobId } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import schedule from 'node-schedule';

interface ScheduledJob {
  id: JobId;
  job: schedule.Job;
  name: string;
  type: 'process' | 'command';
  interval: 'seconds' | 'minutes' | 'hours' | 'fixed';
  cronSchedule: string;
  /** Ungated runner — used for manual runs, bypasses the enabled flag. */
  run: () => void;
  running?: () => boolean;
  cancelFn?: () => void;
}

export const scheduledJobs: ScheduledJob[] = [];

interface RegisterJobOptions {
  id: JobId;
  name: string;
  type: 'process' | 'command';
  interval: 'seconds' | 'minutes' | 'hours' | 'fixed';
  run: () => void;
  running?: () => boolean;
  cancelFn?: () => void;
}

/**
 * Register a scheduled job. The schedule always stays registered (so the job
 * stays listed and Run Now keeps working), but scheduled ticks are skipped
 * while the job is disabled in settings. Manual runs bypass the gate.
 */
const registerJob = (opts: RegisterJobOptions): void => {
  const cronSchedule = getSettings().jobs[opts.id].schedule;
  const gatedRun = (): void => {
    if (getSettings().jobs[opts.id]?.enabled === false) {
      logger.debug(`Skipping scheduled job: ${opts.name} (disabled)`, {
        label: 'Jobs',
      });
      return;
    }
    opts.run();
  };
  scheduledJobs.push({
    id: opts.id,
    name: opts.name,
    type: opts.type,
    interval: opts.interval,
    cronSchedule,
    job: schedule.scheduleJob(cronSchedule, gatedRun),
    run: opts.run,
    running: opts.running,
    cancelFn: opts.cancelFn,
  });
};

export const startJobs = (): void => {
  // Plex Recently Added Scan removed - not needed for collections-only app

  // Plex Full Library Scan removed - not needed for collections-only app

  // Radarr Scan removed - not needed for collections-only app

  // Sonarr Scan removed - not needed for collections-only app

  // Media Availability Sync removed - not needed for collections-only app

  registerJob({
    id: 'plex-collections-sync',
    name: 'Plex Collections Sync',
    type: 'process',
    interval: 'hours',
    run: () => {
      // Check if any collections are configured before running
      const settings = getSettings();
      const hasCollections =
        settings.plex.collectionConfigs &&
        settings.plex.collectionConfigs.length > 0;

      if (!hasCollections) {
        logger.debug(
          'Skipping scheduled Plex Collections Sync: No collections configured',
          {
            label: 'Jobs',
          }
        );
        return;
      }

      logger.info('Starting scheduled job: Plex Collections Sync', {
        label: 'Jobs',
      });
      collectionsSync.run();
    },
    running: () => collectionsSync.status.running,
    cancelFn: () => collectionsSync.cancel(),
  });

  registerJob({
    id: 'plex-collections-quick-sync',
    name: 'Collections Quick Sync',
    type: 'process',
    interval: 'minutes',
    run: () => {
      logger.info('Starting scheduled job: Collections Quick Sync', {
        label: 'Jobs',
      });
      collectionsQuickSync.run();
    },
    running: () => collectionsQuickSync.status.running,
    cancelFn: () => collectionsQuickSync.cancel(),
  });

  registerJob({
    id: 'plex-randomize-home-order',
    name: 'Plex Randomize Home Order',
    type: 'process',
    interval: 'minutes',
    run: () => {
      logger.info('Starting scheduled job: Plex Randomize Home Order', {
        label: 'Jobs',
      });
      randomizeHomeOrder.run();
    },
    running: () => randomizeHomeOrder.status.running,
    cancelFn: () => randomizeHomeOrder.cancel(),
  });

  registerJob({
    id: 'overlay-application',
    name: 'Overlay Application',
    type: 'process',
    interval: 'hours',
    run: () => {
      logger.info('Starting scheduled job: Overlay Application', {
        label: 'Jobs',
      });
      overlayApplication.run();
    },
    running: () => overlayApplication.status.running,
    cancelFn: () => overlayApplication.cancel(),
  });

  registerJob({
    id: 'overlay-quick-sync',
    name: 'Overlay Quick Sync',
    type: 'process',
    interval: 'minutes',
    run: () => {
      logger.info('Starting scheduled job: Overlay Quick Sync', {
        label: 'Jobs',
      });
      overlaysQuickSync.run();
    },
    running: () => overlaysQuickSync.status.running,
    cancelFn: () => overlaysQuickSync.cancel(),
  });

  registerJob({
    id: 'plex-refresh-token',
    name: 'Plex Refresh Token',
    type: 'process',
    interval: 'fixed',
    run: () => {
      logger.info('Starting scheduled job: Plex Refresh Token', {
        label: 'Jobs',
      });
      refreshToken.run();
    },
  });

  registerJob({
    id: 'watchlist-sync',
    name: 'Plex Watchlist Sync',
    type: 'process',
    interval: 'hours',
    run: () => {
      // Check if watchlist sync is enabled
      const settings = getSettings();
      const syncSettings = settings.watchlistSync;

      if (!syncSettings.enableOwner && !syncSettings.enableUsers) {
        logger.debug('Skipping scheduled Watchlist Sync: Not enabled', {
          label: 'Jobs',
        });
        return;
      }

      logger.info('Starting scheduled job: Plex Watchlist Sync', {
        label: 'Jobs',
      });
      watchlistSync.run();
    },
    running: () => watchlistSync.status.running,
    cancelFn: () => watchlistSync.cancel(),
  });

  registerJob({
    id: 'plex-delete-unlabelled-collections',
    name: 'Delete Unlabelled Collections',
    type: 'process',
    interval: 'fixed',
    run: () => {
      logger.info('Starting scheduled job: Delete Unlabelled Collections', {
        label: 'Jobs',
      });
      deleteUnlabelledCollections.run();
    },
    running: () => deleteUnlabelledCollections.status.running,
    cancelFn: () => deleteUnlabelledCollections.cancel(),
  });

  registerJob({
    id: 'plex-edition-manager',
    name: 'Edition Manager (Full, Combined)',
    type: 'process',
    interval: 'fixed',
    run: () => {
      logger.info('Starting scheduled job: Edition Manager (Full, Combined)', { label: 'Jobs' });
      editionManager.run('full', 'all');
    },
    running: () => editionManager.status.running,
    cancelFn: () => editionManager.cancel(),
  });

  registerJob({
    id: 'plex-edition-manager-incremental',
    name: 'Edition Manager (Incremental, Combined)',
    type: 'process',
    interval: 'fixed',
    run: () => {
      logger.info('Starting scheduled job: Edition Manager (Incremental, Combined)', { label: 'Jobs' });
      editionManager.run('incremental', 'all');
    },
    running: () => editionManager.status.running,
    cancelFn: () => editionManager.cancel(),
  });

  registerJob({
    id: 'plex-edition-manager-movies',
    name: 'Edition Manager Movies (Full)',
    type: 'process',
    interval: 'fixed',
    run: () => {
      logger.info('Starting scheduled job: Edition Manager Movies (Full)', { label: 'Jobs' });
      editionManager.run('full', 'movies');
    },
    running: () => editionManager.status.running,
    cancelFn: () => editionManager.cancel(),
  });

  registerJob({
    id: 'plex-edition-manager-movies-incremental',
    name: 'Edition Manager Movies (Incremental)',
    type: 'process',
    interval: 'fixed',
    run: () => {
      logger.info('Starting scheduled job: Edition Manager Movies (Incremental)', { label: 'Jobs' });
      editionManager.run('incremental', 'movies');
    },
    running: () => editionManager.status.running,
    cancelFn: () => editionManager.cancel(),
  });

  registerJob({
    id: 'plex-edition-manager-tv',
    name: 'Edition Manager TV (Full)',
    type: 'process',
    interval: 'fixed',
    run: () => {
      logger.info('Starting scheduled job: Edition Manager TV (Full)', { label: 'Jobs' });
      editionManager.run('full', 'shows');
    },
    running: () => editionManager.status.running,
    cancelFn: () => editionManager.cancel(),
  });

  registerJob({
    id: 'plex-edition-manager-tv-incremental',
    name: 'Edition Manager TV (Incremental)',
    type: 'process',
    interval: 'fixed',
    run: () => {
      logger.info('Starting scheduled job: Edition Manager TV (Incremental)', { label: 'Jobs' });
      editionManager.run('incremental', 'shows');
    },
    running: () => editionManager.status.running,
    cancelFn: () => editionManager.cancel(),
  });

  logger.info('Scheduled jobs loaded', { label: 'Jobs' });
};
