/**
 * Edition Manager Modules
 *
 * Pure functions ported from LJAM96/edition-manager (Python).
 * Each function receives a PlexMovieData object and returns a formatted
 * string or null when the module has nothing to contribute.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface PlexStream {
  streamType: number; // 1=video, 2=audio, 3=subtitle
  codec?: string;
  profile?: string;
  title?: string;
  displayTitle?: string;
  channels?: number;
  bitrate?: number;
  colorTrc?: string;
  colorPrimaries?: string;
  videoDynamicRange?: string;
  videoDynamicRangeType?: string;
  doviProfile?: number;
  language?: string;
  languageTag?: string;
}

export interface PlexPart {
  file?: string;
  size?: number;
  Stream?: PlexStream[];
}

export interface PlexMedia {
  videoResolution?: string;
  videoCodec?: string;
  videoFrameRate?: string;
  bitrate?: number;
  Part?: PlexPart[];
}

export interface PlexMovieData {
  ratingKey?: string;
  title?: string;
  year?: number;
  duration?: number;
  contentRating?: string;
  rating?: number;
  audienceRating?: number;
  studio?: string;
  Media?: PlexMedia[];
  Genre?: { tag: string }[];
  Director?: { tag: string }[];
  Country?: { tag: string }[];
  // Plex stores studio as a top-level field AND sometimes in Studio array
  Studio?: { tag: string }[];
  Writer?: { tag: string }[];
  Role?: { tag: string }[];
}

export interface LanguageOptions {
  excludedLanguages: string[]; // e.g. ['English']
  skipMultipleAudioTracks: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getVideoStreams(data: PlexMovieData): PlexStream[] {
  return (data.Media ?? []).flatMap(
    (m) => (m.Part ?? []).flatMap((p) => (p.Stream ?? []).filter((s) => s.streamType === 1))
  );
}

function getAudioStreams(data: PlexMovieData): PlexStream[] {
  return (data.Media ?? []).flatMap(
    (m) => (m.Part ?? []).flatMap((p) => (p.Stream ?? []).filter((s) => s.streamType === 2))
  );
}

function getFileName(data: PlexMovieData): string {
  return (
    data.Media?.[0]?.Part?.[0]?.file?.split('/').pop()?.replace(/\.[^/.]+$/, '') ?? ''
  );
}

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

export function getResolution(data: PlexMovieData): string | null {
  const ORDER = ['480P', '576P', '720P', '1080P', '2K', '4K', '8K'];
  const resolutions = new Set<string>();

  for (const m of data.Media ?? []) {
    const res = m.videoResolution;
    if (!res) continue;
    const r = res.toUpperCase();
    resolutions.add(/^\d+$/.test(r) ? `${r}p` : r);
  }

  if (!resolutions.size) return null;

  const sorted = Array.from(resolutions).sort((a, b) => {
    const ai = ORDER.indexOf(a);
    const bi = ORDER.indexOf(b);
    return (ai < 0 ? ORDER.length : ai) - (bi < 0 ? ORDER.length : bi);
  });

  return sorted.join(' / ');
}

export function getDynamicRange(data: PlexMovieData): string | null {
  const videos = getVideoStreams(data);
  if (!videos.length) return null;

  const stream = videos[0];
  const colorTrc = (stream.colorTrc ?? '').toLowerCase();
  const colorPrimaries = (stream.colorPrimaries ?? '').toLowerCase();
  const vdr = (stream.videoDynamicRange ?? '').toLowerCase();
  const vdrt = (stream.videoDynamicRangeType ?? '').toLowerCase();
  const doviProfile = stream.doviProfile;

  // Dolby Vision check
  if (doviProfile !== undefined && doviProfile >= 0) {
    if (doviProfile === 8) {
      // Profile 8 = DV + HDR10 fallback
      return 'DV HDR';
    }
    return 'DV';
  }

  // HDR10+
  if (vdrt.includes('hdr10+') || vdrt.includes('hdr10 plus')) return 'HDR10+';

  // HDR10
  if (
    colorTrc.includes('smpte2084') ||
    colorPrimaries.includes('bt2020') ||
    vdr === 'hdr' ||
    vdrt.includes('hdr10')
  ) {
    return 'HDR';
  }

  // HLG
  if (colorTrc.includes('arib-std-b67') || vdrt.includes('hlg')) return 'HLG';

  return 'SDR';
}

export function getAudioCodec(data: PlexMovieData): string | null {
  const CODEC_MAP: Record<string, string> = {
    dca: 'DTS',
    'dca-ma': 'DTS-X',
    'dts-hd ma': 'DTS-HD MA',
    'dts-x': 'DTS-X',
    'dts-hd': 'DTS-HD',
    eac3: 'Atmos',
    'eac3 atmos': 'Atmos',
    'truehd atmos': 'Atmos',
    truehd: 'TrueHD',
    ac3: 'Dolby Digital',
    aac: 'AAC',
    mp3: 'MP3',
    flac: 'FLAC',
    pcm: 'PCM',
    opus: 'Opus',
    vorbis: 'Vorbis',
  };

  const audios = getAudioStreams(data);
  if (!audios.length) return null;

  const audio = audios[0];
  const title = (audio.title ?? '').toLowerCase();
  const displayTitle = (audio.displayTitle ?? '').toLowerCase();
  const codec = (audio.codec ?? '').toLowerCase();

  // Check title/displayTitle first for more specific labels
  for (const [key, label] of Object.entries(CODEC_MAP)) {
    if (title.includes(key) || displayTitle.includes(key)) return label;
  }

  return CODEC_MAP[codec] ?? (codec ? codec.toUpperCase() : null);
}

export function getVideoCodec(data: PlexMovieData): string | null {
  const CODEC_MAP: Record<string, string> = {
    h264: 'H.264',
    avc: 'H.264',
    hevc: 'H.265',
    h265: 'H.265',
    av1: 'AV1',
    vp9: 'VP9',
    vp8: 'VP8',
    mpeg4: 'MPEG-4',
    mpeg2video: 'MPEG-2',
    wmv3: 'WMV',
    vc1: 'VC-1',
  };

  const videos = getVideoStreams(data);
  if (!videos.length) {
    // Fall back to Media[0].videoCodec
    const codec = data.Media?.[0]?.videoCodec?.toLowerCase() ?? '';
    return CODEC_MAP[codec] ?? (codec ? codec.toUpperCase() : null);
  }

  const codec = (videos[0].codec ?? '').toLowerCase();
  return CODEC_MAP[codec] ?? (codec ? codec.toUpperCase() : null);
}

export function getSource(data: PlexMovieData): string | null {
  const SOURCE_MAP: [RegExp, string][] = [
    [/\b(remux)\b/i, 'Remux'],
    [/\b(blu.?ray|bdrip|brrip)\b/i, 'Blu-ray'],
    [/\b(uhd.?blu.?ray|uhd.?bd)\b/i, 'UHD Blu-ray'],
    [/\b(web.?dl|webdl)\b/i, 'WEB-DL'],
    [/\b(webrip|web-rip)\b/i, 'WEBRip'],
    [/\b(hd.?dvd)\b/i, 'HD DVD'],
    [/\b(dvd.?rip|dvdrip)\b/i, 'DVDRip'],
    [/\b(dvd)\b/i, 'DVD'],
    [/\b(hdtv)\b/i, 'HDTV'],
    [/\b(cam|camrip|ts|telesync|tc|telecine)\b/i, 'CAM'],
  ];

  const fileName = getFileName(data);

  for (const [pattern, label] of SOURCE_MAP) {
    if (pattern.test(fileName)) return label;
  }

  return null;
}

export function getCut(data: PlexMovieData): string | null {
  const CUT_MAP: [RegExp, string][] = [
    [/\b(directors.?cut|director.?cut)\b/i, "Director's Cut"],
    [/\b(extended.?cut|extended)\b/i, 'Extended Cut'],
    [/\b(theatrical.?cut|theatrical)\b/i, 'Theatrical Cut'],
    [/\b(unrated)\b/i, 'Unrated'],
    [/\b(final.?cut)\b/i, 'Final Cut'],
    [/\b(special.?edition)\b/i, 'Special Edition'],
    [/\b(remastered)\b/i, 'Remastered'],
    [/\b(redux)\b/i, 'Redux'],
    [/\b(ultimate.?cut)\b/i, 'Ultimate Cut'],
    [/\b(international.?cut)\b/i, 'International Cut'],
    [/\b(collectors.?edition)\b/i, "Collector's Edition"],
  ];

  const fileName = getFileName(data);

  for (const [pattern, label] of CUT_MAP) {
    if (pattern.test(fileName)) return label;
  }

  return null;
}

export function getRelease(data: PlexMovieData): string | null {
  const RELEASE_MAP: [RegExp, string][] = [
    [/\b(criterion)\b/i, 'Criterion'],
    [/\b(arrow)\b/i, 'Arrow'],
    [/\b(4k.?remaster|4k.?restoration)\b/i, '4K Remaster'],
    [/\b(restored)\b/i, 'Restored'],
    [/\b(anniversary)\b/i, 'Anniversary'],
  ];

  const fileName = getFileName(data);

  for (const [pattern, label] of RELEASE_MAP) {
    if (pattern.test(fileName)) return label;
  }

  return null;
}

export function getAudioChannels(data: PlexMovieData): string | null {
  const audios = getAudioStreams(data);
  if (!audios.length) return null;

  const ch = audios[0].channels;
  if (ch === undefined) return null;

  const MAP: Record<number, string> = {
    1: 'Mono',
    2: 'Stereo',
    6: '5.1',
    7: '6.1',
    8: '7.1',
  };

  return MAP[ch] ?? `${ch}ch`;
}

export function getBitrate(data: PlexMovieData): string | null {
  const bitrate = data.Media?.[0]?.bitrate;
  if (!bitrate || bitrate <= 0) return null;

  if (bitrate >= 1000) {
    return `${(bitrate / 1000).toFixed(1)} Mbps`;
  }
  return `${bitrate} kbps`;
}

export function getLanguage(
  data: PlexMovieData,
  opts: LanguageOptions
): string | null {
  const audios = getAudioStreams(data);
  if (!audios.length) return null;

  const excluded = new Set(opts.excludedLanguages.map((l) => l.toLowerCase()));

  const languages = audios
    .map((s) => s.language ?? s.languageTag ?? '')
    .filter((l) => l && !excluded.has(l.toLowerCase()));

  if (!languages.length) return null;
  if (opts.skipMultipleAudioTracks && languages.length > 1) return null;

  // Deduplicate, preserve order
  const unique = Array.from(new Set(languages));
  return unique.join(' / ');
}

export async function getRating(
  data: PlexMovieData,
  source: 'imdb' | 'rotten_tomatoes' | 'letterboxd',
  rtType: 'critic' | 'audience',
  tmdbApiKey?: string
): Promise<string | null> {
  if (source === 'rotten_tomatoes') {
    // Use Plex's built-in audienceRating (RT audience) or rating (critic)
    const val = rtType === 'audience' ? data.audienceRating : data.rating;
    if (!val) return null;
    return `${Math.round(val * 10)}%`;
  }

  if (source === 'imdb' && tmdbApiKey) {
    try {
      const { default: axios } = await import('axios');
      const title = encodeURIComponent(data.title ?? '');
      const year = data.year ?? '';
      const resp = await axios.get(
        `https://api.themoviedb.org/3/search/movie?api_key=${tmdbApiKey}&query=${title}&year=${year}&language=en-US`
      );
      const results = resp.data?.results ?? [];
      if (!results.length) return null;
      const rating = results[0].vote_average;
      if (!rating) return null;
      return `IMDb ${rating.toFixed(1)}`;
    } catch {
      return null;
    }
  }

  return null;
}

export function getSize(data: PlexMovieData): string | null {
  let maxSize = 0;
  for (const m of data.Media ?? []) {
    for (const p of m.Part ?? []) {
      const sz = p.size ?? 0;
      if (sz > maxSize) maxSize = sz;
    }
  }

  if (maxSize <= 0) return null;

  const gib = maxSize / 1024 ** 3;
  const mib = maxSize / 1024 ** 2;

  return gib >= 1 ? `${gib.toFixed(1)} GB` : `${Math.round(mib)} MB`;
}

export function getContentRating(data: PlexMovieData): string | null {
  return data.contentRating ?? null;
}

export function getDirector(data: PlexMovieData): string | null {
  const names = (data.Director ?? []).map((d) => d.tag).filter(Boolean);
  return names[0] ?? null;
}

export function getDuration(data: PlexMovieData): string | null {
  const ms = data.duration;
  if (!ms) return null;

  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;

  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

export function getFrameRate(data: PlexMovieData): string | null {
  const media = data.Media?.[0];
  if (!media) return null;

  const fr = media.videoFrameRate;
  if (!fr) return null;

  try {
    const val = parseFloat(fr.toLowerCase().replace('p', ''));
    if (isNaN(val)) return `${fr}fps`;
    return Math.abs(val - Math.round(val)) < 0.01
      ? `${Math.round(val)}fps`
      : `${val.toFixed(2)}fps`;
  } catch {
    return `${fr}fps`;
  }
}

export function getGenre(data: PlexMovieData): string | null {
  const names = (data.Genre ?? []).map((g) => g.tag).filter(Boolean);
  return names[0] ?? null;
}

const COUNTRY_SHORT_MAP: Record<string, string> = {
  'United States of America': 'United States',
  'Czech Republic': 'Czechia',
  'Macedonia, The Former Yugoslav Republic of': 'Macedonia',
  'Federal Republic of Germany': 'Germany',
  'Republic of Moldova': 'Moldova',
  'Russian Federation': 'Russia',
  'United Kingdom of Great Britain and Northern Ireland': 'United Kingdom',
  'Korea, Republic of': 'South Korea',
  'Republic of Korea': 'South Korea',
  "Korea, Democratic People's Republic of": 'North Korea',
  'Hong Kong SAR China': 'Hong Kong',
  'Macau SAR China': 'Macau',
  'Taiwan, Province of China': 'Taiwan',
  'Viet Nam': 'Vietnam',
  "Lao People's Democratic Republic": 'Laos',
  'Iran, Islamic Republic of': 'Iran',
  'Islamic Republic of Iran': 'Iran',
  'Syrian Arab Republic': 'Syria',
  'Republic of the Union of Myanmar': 'Myanmar',
  "People's Republic of China": 'China',
  'United Arab Emirates': 'UAE',
  'Kingdom of Saudi Arabia': 'Saudi Arabia',
  'Bolivarian Republic of Venezuela': 'Venezuela',
  'Venezuela, Bolivarian Republic of': 'Venezuela',
};

const FINANCEY_COUNTRIES = new Set([
  'uae',
  'united arab emirates',
  'qatar',
  'luxembourg',
  'liechtenstein',
  'malta',
  'monaco',
  'saudi arabia',
  'hong kong',
  'singapore',
  'cayman islands',
  'bahamas',
]);

export function getCountry(data: PlexMovieData): string | null {
  const rawTags = (data.Country ?? []).map((c) => c.tag).filter(Boolean);
  if (!rawTags.length) return null;

  const mapped = rawTags.map((t) => (COUNTRY_SHORT_MAP[t] ?? t).trim());

  for (const tag of mapped) {
    if (!FINANCEY_COUNTRIES.has(tag.toLowerCase())) return tag;
  }

  return mapped[0] ?? null;
}

export function getShortFilm(data: PlexMovieData): string | null {
  const ms = data.duration;
  if (!ms) return null;
  return Math.floor(ms / 60000) < 40 ? 'Short Film' : null;
}

export function getStudio(data: PlexMovieData): string | null {
  if (data.studio) return data.studio;
  const names = (data.Studio ?? []).map((s) => s.tag).filter(Boolean);
  return names[0] ?? null;
}

export function getWriter(data: PlexMovieData): string | null {
  const names = (data.Writer ?? []).map((w) => w.tag).filter(Boolean);
  return names[0] ?? null;
}

// SpecialFeatures requires a separate API call — handled in the job itself.
// This is a placeholder returning null (the job will handle it separately).
export function getSpecialFeatures(): string | null {
  return null;
}

// ---------------------------------------------------------------------------
// Module registry — maps module name to its function
// ---------------------------------------------------------------------------

export const ALL_MODULES = [
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

export type ModuleName = (typeof ALL_MODULES)[number];

export const DEFAULT_ENABLED_MODULES: ModuleName[] = [
  'Resolution',
  'Size',
  'Source',
  'Bitrate',
  'DynamicRange',
  'Release',
  'Cut',
  'AudioCodec',
];
