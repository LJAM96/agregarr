/**
 * Delete Unlabelled Collections Job
 *
 * Scans all Plex movie and show libraries and permanently deletes any collection
 * that has no labels attached. Collections with at least one label are kept.
 *
 * This mirrors the logic from p-collection-cleaner (LJAM96/p-collection-cleaner)
 * but runs natively inside Agregarr using the existing Plex API client.
 */

import logger from '@server/logger';

export interface DeleteUnlabelledCollectionsStatus {
  running: boolean;
  cancelled: boolean;
  total: number;
  deleted: number;
  skipped: number;
  failed: number;
}

class DeleteUnlabelledCollections {
  private cancelled = false;

  public status: DeleteUnlabelledCollectionsStatus = {
    running: false,
    cancelled: false,
    total: 0,
    deleted: 0,
    skipped: 0,
    failed: 0,
  };

  public async run(): Promise<void> {
    if (this.status.running) {
      logger.warn('Delete Unlabelled Collections already in progress', {
        label: 'Delete Unlabelled Collections',
      });
      return;
    }

    logger.info('Starting Delete Unlabelled Collections', {
      label: 'Delete Unlabelled Collections',
    });

    this.status = {
      running: true,
      cancelled: false,
      total: 0,
      deleted: 0,
      skipped: 0,
      failed: 0,
    };
    this.cancelled = false;

    try {
      const { getAdminUser } = await import(
        '@server/lib/collections/core/CollectionUtilities'
      );
      const PlexAPI = (await import('@server/api/plexapi')).default;
      const { getSettings } = await import('@server/lib/settings');

      const admin = await getAdminUser();
      if (!admin?.plexToken) {
        throw new Error('No local admin Plex token found');
      }

      const settings = getSettings();
      const plexClient = new PlexAPI({
        plexToken: admin.plexToken,
        plexSettings: settings.plex,
      });

      logger.debug('Fetching all Plex collections', {
        label: 'Delete Unlabelled Collections',
      });

      const allCollections = await plexClient.getAllCollections();
      this.status.total = allCollections.length;

      logger.info(
        `Found ${allCollections.length} collection(s) across all libraries`,
        { label: 'Delete Unlabelled Collections' }
      );

      for (const collection of allCollections) {
        if (this.cancelled) {
          logger.info('Delete Unlabelled Collections cancelled', {
            label: 'Delete Unlabelled Collections',
          });
          this.status.cancelled = true;
          break;
        }

        const hasLabels = Array.isArray(collection.labels)
          ? collection.labels.length > 0
          : false;

        if (hasLabels) {
          logger.debug(
            `Keeping '${collection.title}' (labels: ${collection.labels.join(', ')})`,
            { label: 'Delete Unlabelled Collections' }
          );
          this.status.skipped++;
          continue;
        }

        // No labels — delete
        logger.info(
          `Deleting unlabelled collection '${collection.title}' (ratingKey: ${collection.ratingKey}, library: ${collection.libraryName ?? collection.libraryKey})`,
          { label: 'Delete Unlabelled Collections' }
        );

        try {
          await plexClient.deleteCollection(collection.ratingKey);
          this.status.deleted++;
          logger.debug(`Deleted '${collection.title}'`, {
            label: 'Delete Unlabelled Collections',
          });
        } catch (deleteError) {
          this.status.failed++;
          logger.error(
            `Failed to delete collection '${collection.title}': ${
              deleteError instanceof Error
                ? deleteError.message
                : String(deleteError)
            }`,
            { label: 'Delete Unlabelled Collections' }
          );
        }
      }

      logger.info(
        `Delete Unlabelled Collections complete — deleted: ${this.status.deleted}, kept: ${this.status.skipped}, failed: ${this.status.failed}`,
        { label: 'Delete Unlabelled Collections' }
      );
    } catch (error) {
      logger.error('Delete Unlabelled Collections failed', {
        label: 'Delete Unlabelled Collections',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.status.running = false;
    }
  }

  public cancel(): void {
    logger.info('Cancelling Delete Unlabelled Collections', {
      label: 'Delete Unlabelled Collections',
    });
    this.cancelled = true;
  }
}

const deleteUnlabelledCollections = new DeleteUnlabelledCollections();
export default deleteUnlabelledCollections;
