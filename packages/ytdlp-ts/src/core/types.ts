export type EngineKind = 'auto' | 'native' | 'reference'

export interface Format {
  format_id: string
  url: string
  ext?: string
  protocol?: string
  format_note?: string
  width?: number
  height?: number
  fps?: number
  vcodec?: string
  acodec?: string
  tbr?: number
  abr?: number
  vbr?: number
  filesize?: number
  filesize_approx?: number
  language?: string
  quality?: number
  preference?: number
  http_headers?: Record<string, string>
  [key: string]: unknown
}

export interface Subtitle {
  url: string
  ext?: string
  name?: string
  data?: string
  [key: string]: unknown
}

export interface Thumbnail {
  id?: string
  url: string
  width?: number
  height?: number
  preference?: number
  [key: string]: unknown
}

export interface MediaInfo {
  id: string
  title: string
  _type?: 'video' | 'playlist' | 'url' | 'url_transparent' | 'multi_video'
  webpage_url?: string
  original_url?: string
  url?: string
  ext?: string
  extractor?: string
  extractor_key?: string
  description?: string | null
  uploader?: string
  uploader_id?: string
  channel?: string
  channel_id?: string
  duration?: number
  timestamp?: number
  upload_date?: string
  live_status?: string
  view_count?: number
  like_count?: number
  age_limit?: number
  formats?: Format[]
  requested_formats?: Format[]
  subtitles?: Record<string, Subtitle[]>
  automatic_captions?: Record<string, Subtitle[]>
  thumbnails?: Thumbnail[]
  thumbnail?: string
  entries?: MediaInfo[]
  playlist_count?: number
  [key: string]: unknown
}

export type ProgressEvent =
  | {
      status: 'downloading'
      filename: string
      downloadedBytes: number
      totalBytes?: number
      speed?: number
      eta?: number
    }
  | { status: 'finished'; filename: string; totalBytes: number }
  | { status: 'postprocessing'; filename: string; operation: string }
  | { status: 'error'; error: string }
