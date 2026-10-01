import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import type { EditionManagerSettings } from '@server/lib/settings';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Bars3Icon, PlayIcon } from '@heroicons/react/24/solid';
import axios from 'axios';
import { useCallback, useEffect, useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';
import useSWR from 'swr';

const ALL_MODULES = [
  'AudioChannels',
  'AudioCodec',
  'Bitrate',
  'ContentRating',
  'Country',
  'Cut',
  'Director',
  'Duration',
  'DynamicRange',
  'FrameRate',
  'Genre',
  'Language',
  'Rating',
  'Release',
  'Resolution',
  'ShortFilm',
  'Size',
  'Source',
  'SpecialFeatures',
  'Studio',
  'VideoCodec',
  'Writer',
] as const;

const DEFAULT_ENABLED_MODULES = [
  'Resolution',
  'Size',
  'Source',
  'Bitrate',
  'DynamicRange',
  'Release',
  'Cut',
  'AudioCodec',
];

const DEFAULT_TV_ENABLED_MODULES = ['Resolution', 'Source'];

const messages = defineMessages({
  editions: 'Editions',
  editionManager: 'Edition Manager',
  description:
    'Automatically write Plex editionTitle metadata for movies and TV shows based on the enabled modules below.',
  moviesSection: 'Movies (type=1)',
  moviesDescription:
    'Per-movie editions built from each file’s streams. Runs over all movie libraries.',
  tvSection: 'TV Shows (type=2, show-level)',
  tvDescription:
    'Show-level editions aggregated from sampled episodes (first episode per season, up to 5). Size/Bitrate/Duration are skipped for TV since they vary per episode. Defaults to Resolution + Source, e.g. “1080p · WEB-DL”.',
  tvEnabled: 'Enable TV show editions',
  enabledModules: 'Enabled Modules (drag to reorder)',
  tvEnabledModules: 'TV Enabled Modules (drag to reorder)',
  availableModules: 'Available Modules',
  tvAvailableModules: 'TV Available Modules',
  separator: 'Movies Separator',
  tvSeparator: 'TV Separator',
  separatorTip: 'String inserted between module outputs, e.g. " · " or " | "',
  ratingSource: 'Rating Source',
  ratingSourceImdb: 'IMDb (via TMDb API)',
  ratingSourceRt: 'Rotten Tomatoes',
  ratingSourceLetterboxd: 'Letterboxd',
  rtType: 'Rotten Tomatoes Type',
  rtCritic: 'Critic Score',
  rtAudience: 'Audience Score',
  languageExcluded: 'Excluded Languages',
  languageExcludedTip:
    'Comma-separated list of language names to exclude from the Language module (e.g. English)',
  languageSkipMultiple: 'Skip Language when Multiple Tracks',
  toastSuccess: 'Edition Manager settings saved.',
  toastFailure: 'Failed to save Edition Manager settings.',
  toastRunSuccess: 'Edition Manager job started.',
  toastRunFailure: 'Failed to start Edition Manager job.',
  toastRunConflict: 'Edition Manager is already running.',
  toastPreviewFailure: 'TV preview failed.',
  runFull: 'Run Full',
  runIncremental: 'Run Incremental',
  runMoviesFull: 'Run Movies Full',
  runMoviesIncremental: 'Run Movies Incremental',
  runTvFull: 'Run TV Full',
  runTvIncremental: 'Run TV Incremental',
  previewTv: 'Preview TV Editions',
  previewing: 'Previewing…',
  tvPreviewTitle: 'Preview a specific show (optional)',
  tvPreviewPlaceholder: 'e.g. Lanterns — blank previews the first shows',
  tvPreviewResults: 'Preview results (read-only, nothing written)',
  tvPreviewCurrent: 'current',
  tvPreviewNone: 'none',
  save: 'Save Changes',
  saving: 'Saving…',
});

// ---------------------------------------------------------------------------
// Sortable module row
// ---------------------------------------------------------------------------

interface SortableModuleRowProps {
  id: string;
  onRemove: (id: string) => void;
}

const SortableModuleRow = ({ id, onRemove }: SortableModuleRowProps) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 ${
        isDragging ? 'z-50 opacity-50' : ''
      }`}
    >
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab p-1 text-gray-400 hover:text-white active:cursor-grabbing"
        aria-label="Drag to reorder"
      >
        <Bars3Icon className="h-4 w-4" />
      </div>
      <span className="flex-1 text-sm text-white">{id}</span>
      <button
        type="button"
        onClick={() => onRemove(id)}
        className="text-xs text-gray-400 hover:text-red-400"
        aria-label={`Remove ${id}`}
      >
        ✕
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const SettingsEditionManager = () => {
  const intl = useIntl();
  const { addToast } = useToasts();

  const { data, error, mutate: revalidate } = useSWR<EditionManagerSettings>(
    '/api/v1/settings/edition-manager'
  );

  const [enabledModules, setEnabledModules] = useState<string[]>([]);
  const [separator, setSeparator] = useState(' · ');
  const [tvEnabled, setTvEnabled] = useState(true);
  const [tvEnabledModules, setTvEnabledModules] = useState<string[]>([
    ...DEFAULT_TV_ENABLED_MODULES,
  ]);
  const [tvSeparator, setTvSeparator] = useState(' · ');
  const [ratingSource, setRatingSource] = useState<
    'imdb' | 'rotten_tomatoes' | 'letterboxd'
  >('imdb');
  const [ratingRottenTomatoesType, setRatingRottenTomatoesType] = useState<
    'critic' | 'audience'
  >('critic');
  const [languageExcluded, setLanguageExcluded] = useState('English');
  const [languageSkipMultiple, setLanguageSkipMultiple] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tvPreviewTitle, setTvPreviewTitle] = useState('');
  const [tvPreviewLoading, setTvPreviewLoading] = useState(false);
  const [tvPreviewItems, setTvPreviewItems] = useState<
    {
      ratingKey: string;
      title: string;
      year?: number;
      currentEdition?: string;
      previewEdition: string | null;
      error?: string;
    }[]
  >([]);

  useEffect(() => {
    if (data) {
      setEnabledModules(data.enabledModules ?? [...DEFAULT_ENABLED_MODULES]);
      setSeparator(data.separator ?? ' · ');
      setTvEnabled(data.tvEnabled ?? true);
      setTvEnabledModules(
        data.tvEnabledModules ?? [...DEFAULT_TV_ENABLED_MODULES]
      );
      setTvSeparator(data.tvSeparator ?? data.separator ?? ' · ');
      setRatingSource(data.ratingSource ?? 'imdb');
      setRatingRottenTomatoesType(data.ratingRottenTomatoesType ?? 'critic');
      setLanguageExcluded((data.languageExcluded ?? ['English']).join(', '));
      setLanguageSkipMultiple(data.languageSkipMultiple ?? false);
    }
  }, [data]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      setEnabledModules((prev) => {
        const oldIndex = prev.indexOf(String(active.id));
        const newIndex = prev.indexOf(String(over.id));
        return arrayMove(prev, oldIndex, newIndex);
      });
    },
    []
  );

  const addModule = useCallback((mod: string) => {
    setEnabledModules((prev) => (prev.includes(mod) ? prev : [...prev, mod]));
  }, []);

  const removeModule = useCallback((mod: string) => {
    setEnabledModules((prev) => prev.filter((m) => m !== mod));
  }, []);

  const handleTvDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      setTvEnabledModules((prev) => {
        const oldIndex = prev.indexOf(String(active.id));
        const newIndex = prev.indexOf(String(over.id));
        return arrayMove(prev, oldIndex, newIndex);
      });
    },
    []
  );

  const addTvModule = useCallback((mod: string) => {
    setTvEnabledModules((prev) =>
      prev.includes(mod) ? prev : [...prev, mod]
    );
  }, []);

  const removeTvModule = useCallback((mod: string) => {
    setTvEnabledModules((prev) => prev.filter((m) => m !== mod));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload: EditionManagerSettings = {
        enabledModules,
        separator,
        tvEnabled,
        tvEnabledModules,
        tvSeparator,
        ratingSource,
        ratingRottenTomatoesType,
        languageExcluded: languageExcluded.split(',').map((s) => s.trim()).filter(Boolean),
        languageSkipMultiple,
      };
      await axios.post('/api/v1/settings/edition-manager', payload);
      revalidate();
      addToast(intl.formatMessage(messages.toastSuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.toastFailure), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleScopedRun = async (
    mode: 'full' | 'incremental',
    scope: 'movies' | 'shows'
  ) => {
    try {
      await axios.post('/api/v1/settings/edition-manager/run', { mode, scope });
      addToast(intl.formatMessage(messages.toastRunSuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch (e) {
      if (e.response?.status === 409) {
        addToast(intl.formatMessage(messages.toastRunConflict), {
          appearance: 'warning',
          autoDismiss: true,
        });
      } else {
        addToast(intl.formatMessage(messages.toastRunFailure), {
          appearance: 'error',
          autoDismiss: true,
        });
      }
    }
  };

  const handleTvPreview = async () => {
    setTvPreviewLoading(true);
    try {
      const { data } = await axios.post(
        '/api/v1/settings/edition-manager/tv-preview',
        { limit: 5, title: tvPreviewTitle }
      );
      setTvPreviewItems(data.items ?? []);
    } catch (e) {
      addToast(
        e.response?.data?.message
          ? `TV preview failed: ${e.response.data.message}`
          : intl.formatMessage(messages.toastPreviewFailure),
        {
          appearance: 'error',
          autoDismiss: true,
        }
      );
    } finally {
      setTvPreviewLoading(false);
    }
  };

  if (error) return <div className="text-red-500">Failed to load settings.</div>;
  if (!data) return <LoadingSpinner />;

  const disabledModules = (ALL_MODULES as readonly string[]).filter(
    (m) => !enabledModules.includes(m)
  );

  const tvDisabledModules = (ALL_MODULES as readonly string[]).filter(
    (m) => !tvEnabledModules.includes(m)
  );

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.editions)} />
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.editionManager)}</h3>
        <p className="description">{intl.formatMessage(messages.description)}</p>
      </div>

      {/* ------------------------------------------------ Movies */}
      <div className="section space-y-6">
        <div>
          <h4 className="text-lg font-semibold text-white">
            {intl.formatMessage(messages.moviesSection)}
          </h4>
          <p className="text-sm text-gray-400">
            {intl.formatMessage(messages.moviesDescription)}
          </p>
        </div>

        {/* Enabled Modules (sortable) */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            {intl.formatMessage(messages.enabledModules)}
          </label>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={enabledModules} strategy={verticalListSortingStrategy}>
              <div className="space-y-1">
                {enabledModules.map((mod) => (
                  <SortableModuleRow key={mod} id={mod} onRemove={removeModule} />
                ))}
              </div>
            </SortableContext>
          </DndContext>

          {enabledModules.length === 0 && (
            <p className="text-sm text-gray-500 mt-2">
              No modules enabled. Add some from the list below.
            </p>
          )}
        </div>

        {/* Available (disabled) modules */}
        {disabledModules.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              {intl.formatMessage(messages.availableModules)}
            </label>
            <div className="flex flex-wrap gap-2">
              {disabledModules.map((mod) => (
                <button
                  key={mod}
                  type="button"
                  onClick={() => addModule(mod)}
                  className="rounded-full border border-gray-600 bg-gray-700 px-3 py-1 text-xs text-gray-300 hover:border-indigo-500 hover:text-white"
                >
                  + {mod}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Separator */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            {intl.formatMessage(messages.separator)}
          </label>
          <p className="text-xs text-gray-500 mb-2">
            {intl.formatMessage(messages.separatorTip)}
          </p>
          <input
            type="text"
            value={separator}
            onChange={(e) => setSeparator(e.target.value)}
            className="textInput w-64"
          />
        </div>

        {/* Movies test runs */}
        <div className="flex gap-3">
          <Button
            buttonType="default"
            onClick={() => handleScopedRun('incremental', 'movies')}
            title="Only processes movies that don't already have an edition set"
          >
            <PlayIcon className="mr-2 h-4 w-4" />
            {intl.formatMessage(messages.runMoviesIncremental)}
          </Button>
          <Button
            buttonType="default"
            onClick={() => handleScopedRun('full', 'movies')}
            title="Re-processes all movies, overwriting any existing editions"
          >
            <PlayIcon className="mr-2 h-4 w-4" />
            {intl.formatMessage(messages.runMoviesFull)}
          </Button>
        </div>
      </div>

      {/* ------------------------------------------------ TV Shows */}
      <div className="section space-y-6 mt-6">
        <div>
          <h4 className="text-lg font-semibold text-white">
            {intl.formatMessage(messages.tvSection)}
          </h4>
          <p className="text-sm text-gray-400">
            {intl.formatMessage(messages.tvDescription)}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="tvEnabled"
            checked={tvEnabled}
            onChange={(e) => setTvEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-gray-600 bg-gray-700 text-indigo-600"
          />
          <label htmlFor="tvEnabled" className="text-sm text-gray-300">
            {intl.formatMessage(messages.tvEnabled)}
          </label>
        </div>

        {tvEnabled && (
          <>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                {intl.formatMessage(messages.tvEnabledModules)}
              </label>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleTvDragEnd}
              >
                <SortableContext
                  items={tvEnabledModules}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-1">
                    {tvEnabledModules.map((mod) => (
                      <SortableModuleRow
                        key={`tv-${mod}`}
                        id={mod}
                        onRemove={removeTvModule}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>

              {tvEnabledModules.length === 0 && (
                <p className="text-sm text-gray-500 mt-2">
                  No TV modules enabled. Add some from the list below.
                </p>
              )}
            </div>

            {tvDisabledModules.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  {intl.formatMessage(messages.tvAvailableModules)}
                </label>
                <div className="flex flex-wrap gap-2">
                  {tvDisabledModules.map((mod) => (
                    <button
                      key={mod}
                      type="button"
                      onClick={() => addTvModule(mod)}
                      className="rounded-full border border-gray-600 bg-gray-700 px-3 py-1 text-xs text-gray-300 hover:border-indigo-500 hover:text-white"
                    >
                      + {mod}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                {intl.formatMessage(messages.tvSeparator)}
              </label>
              <p className="text-xs text-gray-500 mb-2">
                {intl.formatMessage(messages.separatorTip)}
              </p>
              <input
                type="text"
                value={tvSeparator}
                onChange={(e) => setTvSeparator(e.target.value)}
                className="textInput w-64"
              />
            </div>

            {/* TV test: read-only preview */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                {intl.formatMessage(messages.tvPreviewTitle)}
              </label>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={tvPreviewTitle}
                  onChange={(e) => setTvPreviewTitle(e.target.value)}
                  placeholder={intl.formatMessage(messages.tvPreviewPlaceholder)}
                  className="textInput w-64"
                />
                <Button
                  buttonType="default"
                  onClick={handleTvPreview}
                  disabled={tvPreviewLoading}
                >
                  <PlayIcon className="mr-2 h-4 w-4" />
                  {tvPreviewLoading
                    ? intl.formatMessage(messages.previewing)
                    : intl.formatMessage(messages.previewTv)}
                </Button>
              </div>
            </div>

            {tvPreviewItems.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  {intl.formatMessage(messages.tvPreviewResults)}
                </label>
                <div className="space-y-1">
                  {tvPreviewItems.map((item) => (
                    <div
                      key={item.ratingKey}
                      className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm"
                    >
                      <span className="text-white">
                        {item.title}
                        {item.year ? ` (${item.year})` : ''}
                      </span>{' '}
                      <span className="text-gray-400">
                        [{intl.formatMessage(messages.tvPreviewCurrent)}:{' '}
                        {item.currentEdition ??
                          intl.formatMessage(messages.tvPreviewNone)}
                        ]
                      </span>
                      {item.error ? (
                        <span className="text-red-400"> — {item.error}</span>
                      ) : (
                        <span className="text-green-400">
                          {' '}
                          → {item.previewEdition ?? '—'}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* TV test runs */}
            <div className="flex gap-3">
              <Button
                buttonType="default"
                onClick={() => handleScopedRun('incremental', 'shows')}
                title="Only processes shows that don't already have an edition set"
              >
                <PlayIcon className="mr-2 h-4 w-4" />
                {intl.formatMessage(messages.runTvIncremental)}
              </Button>
              <Button
                buttonType="default"
                onClick={() => handleScopedRun('full', 'shows')}
                title="Re-processes all shows, overwriting any existing editions"
              >
                <PlayIcon className="mr-2 h-4 w-4" />
                {intl.formatMessage(messages.runTvFull)}
              </Button>
            </div>
          </>
        )}
      </div>

      {/* ------------------------------------------------ Shared */}
      <div className="section space-y-6 mt-6">

        {/* Rating source */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            {intl.formatMessage(messages.ratingSource)}
          </label>
          <select
            value={ratingSource}
            onChange={(e) =>
              setRatingSource(e.target.value as 'imdb' | 'rotten_tomatoes' | 'letterboxd')
            }
            className="select w-64"
          >
            <option value="imdb">{intl.formatMessage(messages.ratingSourceImdb)}</option>
            <option value="rotten_tomatoes">
              {intl.formatMessage(messages.ratingSourceRt)}
            </option>
            <option value="letterboxd">
              {intl.formatMessage(messages.ratingSourceLetterboxd)}
            </option>
          </select>
        </div>

        {ratingSource === 'rotten_tomatoes' && (
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              {intl.formatMessage(messages.rtType)}
            </label>
            <select
              value={ratingRottenTomatoesType}
              onChange={(e) =>
                setRatingRottenTomatoesType(e.target.value as 'critic' | 'audience')
              }
              className="select w-64"
            >
              <option value="critic">{intl.formatMessage(messages.rtCritic)}</option>
              <option value="audience">{intl.formatMessage(messages.rtAudience)}</option>
            </select>
          </div>
        )}

        {/* Language */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-1">
            {intl.formatMessage(messages.languageExcluded)}
          </label>
          <p className="text-xs text-gray-500 mb-2">
            {intl.formatMessage(messages.languageExcludedTip)}
          </p>
          <input
            type="text"
            value={languageExcluded}
            onChange={(e) => setLanguageExcluded(e.target.value)}
            className="textInput w-64"
          />
        </div>

        <div className="flex items-center gap-3">
          <input
            type="checkbox"
            id="languageSkipMultiple"
            checked={languageSkipMultiple}
            onChange={(e) => setLanguageSkipMultiple(e.target.checked)}
            className="h-4 w-4 rounded border-gray-600 bg-gray-700 text-indigo-600"
          />
          <label htmlFor="languageSkipMultiple" className="text-sm text-gray-300">
            {intl.formatMessage(messages.languageSkipMultiple)}
          </label>
        </div>

        {/* Action buttons */}
        <div className="flex gap-3">
          <Button buttonType="primary" onClick={handleSave} disabled={saving}>
            {saving
              ? intl.formatMessage(messages.saving)
              : intl.formatMessage(messages.save)}
          </Button>
        </div>
      </div>
    </>
  );
};

export default SettingsEditionManager;
