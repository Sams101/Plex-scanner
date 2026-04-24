import initSqlJs from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'

const DB_STORE_NAME = 'plex-db-explorer'
const DB_STORE_VERSION = 1
const SESSION_PREFIX = 'plex_explorer_'

const MOVIE = 1
const SHOW = 2
const SEASON = 3
const EPISODE = 4
const ARTIST = 8
const ALBUM = 9
const TRACK = 10

const CATEGORY_CONFIG = {
  movies: { metadataTypes: [MOVIE], sectionType: 1 },
  shows: { metadataTypes: [SHOW], sectionType: 2 },
  music: { metadataTypes: [ARTIST], sectionType: 8 },
  all: { metadataTypes: [MOVIE, SHOW, SEASON, EPISODE, ARTIST, ALBUM, TRACK], sectionType: null },
}

let sqlPromise = null
let currentSession = null

function buildSearchParams(params = {}) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  return search
}

function normalizeValue(value) {
  if (value === undefined) return null
  if (value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  return value
}

function formatTimestamp(value) {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric === 0) return null
  return new Date(numeric * 1000).toISOString().replace('.000Z', 'Z')
}

function msToMinutes(value) {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return Math.round((numeric / 60000) * 100) / 100
}

function slugifySearch(value) {
  const tokens = String(value || '').toLowerCase().match(/[\w]+/gu)
  if (!tokens?.length) return ''
  return tokens.map((token) => `"${token}"`).join(' AND ')
}

function escapeLike(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_')
}

function sortClause(sortBy, direction) {
  const asc = String(direction || '').toLowerCase() !== 'desc'
  const suffix = asc ? 'ASC' : 'DESC'
  if (sortBy === 'year') {
    return `COALESCE(mi.year, 0) ${suffix}, COALESCE(mi.title_sort, mi.title) COLLATE NOCASE ASC`
  }
  if (sortBy === 'date_added') {
    return `COALESCE(mi.added_at, 0) ${suffix}, COALESCE(mi.title_sort, mi.title) COLLATE NOCASE ASC`
  }
  return `COALESCE(mi.title_sort, mi.title) COLLATE NOCASE ${suffix}, COALESCE(mi.year, 0) DESC`
}

function randomToken() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID().replaceAll('-', '')
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
}

function openDatabaseStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_STORE_NAME, DB_STORE_VERSION)
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'))
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'token' })
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
}

async function persistSessionRecord(record) {
  const db = await openDatabaseStore()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite')
    const store = tx.objectStore('sessions')
    const request = store.put(record)
    request.onerror = () => {
      db.close()
      reject(request.error || new Error('Failed to persist session'))
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error || new Error('Failed to persist session'))
    }
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
  })
}

async function loadSessionRecord(token) {
  const db = await openDatabaseStore()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readonly')
    const store = tx.objectStore('sessions')
    const request = store.get(token)
    request.onerror = () => {
      db.close()
      reject(request.error || new Error('Failed to load session'))
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error || new Error('Failed to load session'))
    }
    tx.oncomplete = () => {
      db.close()
      resolve(request.result || null)
    }
  })
}

async function deleteSessionRecord(token) {
  const db = await openDatabaseStore()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite')
    const store = tx.objectStore('sessions')
    const request = store.delete(token)
    request.onerror = () => {
      db.close()
      reject(request.error || new Error('Failed to delete session'))
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error || new Error('Failed to delete session'))
    }
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
  })
}

async function clearAllSessionRecords() {
  const db = await openDatabaseStore()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('sessions', 'readwrite')
    const store = tx.objectStore('sessions')
    const request = store.clear()
    request.onerror = () => {
      db.close()
      reject(request.error || new Error('Failed to clear sessions'))
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error || new Error('Failed to clear sessions'))
    }
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
  })
}

async function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: () => wasmUrl,
    })
  }
  return sqlPromise
}

async function createDatabaseFromFile(file) {
  const SQL = await getSql()
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const header = new TextDecoder().decode(bytes.slice(0, 16))
  if (header !== 'SQLite format 3\u0000') {
    throw new Error('Uploaded file is not a SQLite database')
  }
  const db = new SQL.Database(bytes)
  return { db, bytes, sizeBytes: bytes.byteLength }
}

function toRowObjects(stmt) {
  const rows = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject())
  }
  return rows
}

class PlexRepository {
  constructor(db) {
    this.db = db
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params.map(normalizeValue))
      return toRowObjects(stmt)
    } finally {
      stmt.free()
    }
  }

  get(sql, params = []) {
    return this.all(sql, params)[0] || null
  }

  _baseConditions({ category = 'all', sectionId = null, genre = null, year = null, query = null, includeSearch = true } = {}) {
    const conditions = ['mi.deleted_at IS NULL']
    const params = []
    const config = CATEGORY_CONFIG[category] || CATEGORY_CONFIG.all

    if (config.metadataTypes?.length) {
      conditions.push(`mi.metadata_type IN (${config.metadataTypes.map(() => '?').join(',')})`)
      params.push(...config.metadataTypes)
    }

    if (config.sectionType !== null && config.sectionType !== undefined) {
      conditions.push('ls.section_type = ?')
      params.push(config.sectionType)
    }

    if (sectionId !== null && sectionId !== undefined && sectionId !== '') {
      conditions.push('mi.library_section_id = ?')
      params.push(sectionId)
    }

    if (year !== null && year !== undefined && year !== '') {
      conditions.push('mi.year = ?')
      params.push(year)
    }

    if (genre) {
      conditions.push(`
        EXISTS (
          SELECT 1
          FROM tags t
          JOIN taggings tg ON tg.tag_id = t.id
          WHERE tg.metadata_item_id = mi.id
            AND t.tag_type = 1
            AND lower(t.tag) = lower(?)
        )
      `)
      params.push(genre)
    }

    if (includeSearch && query) {
      const ftsQuery = slugifySearch(query)
      const likeQuery = `%${escapeLike(String(query).toLowerCase())}%`
      conditions.push(`
        (
          lower(coalesce(mi.title, '')) LIKE ? ESCAPE '\\'
          OR lower(coalesce(mi.title_sort, '')) LIKE ? ESCAPE '\\'
          OR lower(coalesce(mi.original_title, '')) LIKE ? ESCAPE '\\'
          OR lower(coalesce(mi.summary, '')) LIKE ? ESCAPE '\\'
          OR lower(coalesce(mi.tagline, '')) LIKE ? ESCAPE '\\'
          OR EXISTS (
            SELECT 1
            FROM fts4_metadata_titles
            WHERE rowid = mi.id
              AND fts4_metadata_titles MATCH ?
          )
        )
      `)
      params.push(likeQuery, likeQuery, likeQuery, likeQuery, likeQuery, ftsQuery || query)
    }

    return { conditions, params }
  }

  _selectClause(includeGenres = true) {
    const genres = includeGenres
      ? `
        , (
          SELECT GROUP_CONCAT(tag)
          FROM (
            SELECT DISTINCT t.tag AS tag
            FROM tags t
            JOIN taggings tg ON tg.tag_id = t.id
            WHERE tg.metadata_item_id = mi.id
              AND t.tag_type = 1
            ORDER BY t.tag
          )
        ) AS genres
      `
      : ''
    return `
      SELECT
        mi.id,
        mi.metadata_type,
        mi.parent_id,
        mi.library_section_id,
        ls.name AS library_name,
        ls.section_type AS library_type,
        mi.title,
        mi.title_sort,
        mi.original_title,
        mi.summary,
        mi.tagline,
        mi.studio,
        mi.rating,
        mi.rating_count,
        mi.content_rating,
        mi.content_rating_age,
        mi."index" AS item_index,
        mi.absolute_index,
        mi.year,
        mi.originally_available_at,
        mi.added_at,
        mi.updated_at,
        mi.media_item_count
        ${genres}
      FROM metadata_items mi
      LEFT JOIN library_sections ls ON ls.id = mi.library_section_id
    `
  }

  _itemRow(row) {
    const title = row.title || row.original_title || ''
    const genres = row.genres ? String(row.genres).split(',').filter(Boolean) : []
    return {
      id: row.id,
      metadataType: row.metadata_type,
      parentId: row.parent_id,
      librarySectionId: row.library_section_id,
      libraryName: row.library_name,
      libraryType: row.library_type,
      title,
      titleSort: row.title_sort,
      originalTitle: row.original_title,
      summary: row.summary,
      tagline: row.tagline,
      studio: row.studio,
      rating: row.rating,
      ratingCount: row.rating_count,
      contentRating: row.content_rating,
      contentRatingAge: row.content_rating_age,
      index: row.item_index ?? row.index,
      absoluteIndex: row.absolute_index,
      year: row.year,
      originallyAvailableAt: formatTimestamp(row.originally_available_at),
      addedAt: formatTimestamp(row.added_at),
      updatedAt: formatTimestamp(row.updated_at),
      mediaItemCount: row.media_item_count,
      genres,
      hasMissingMetadata: !Boolean(title && row.summary),
    }
  }

  listLibraries() {
    return this.all(`
      SELECT
        ls.id,
        ls.name,
        ls.section_type,
        ls.agent,
        ls.scanner,
        COUNT(mi.id) AS item_count
      FROM library_sections ls
      LEFT JOIN metadata_items mi
        ON mi.library_section_id = ls.id
       AND mi.deleted_at IS NULL
      GROUP BY ls.id
      ORDER BY ls.section_type, ls.name
    `)
  }

  summary() {
    const counts = {}
    for (const [name, metaType] of [
      ['movies', MOVIE],
      ['shows', SHOW],
      ['seasons', SEASON],
      ['episodes', EPISODE],
      ['artists', ARTIST],
      ['albums', ALBUM],
      ['tracks', TRACK],
    ]) {
      counts[name] = this.get(
        'SELECT COUNT(*) AS count FROM metadata_items WHERE deleted_at IS NULL AND metadata_type = ?',
        [metaType],
      )?.count || 0
    }

    const recentRows = this.all(`
      SELECT
        mi.id,
        mi.metadata_type,
        mi.title,
        mi.original_title,
        mi.year,
        mi.added_at,
        ls.name AS library_name,
        ls.section_type AS library_type
      FROM metadata_items mi
      LEFT JOIN library_sections ls ON ls.id = mi.library_section_id
      WHERE mi.deleted_at IS NULL
        AND mi.metadata_type IN (1, 2, 8, 9, 10)
      ORDER BY COALESCE(mi.added_at, 0) DESC, mi.id DESC
      LIMIT 20
    `)

    return {
      counts,
      recentlyAdded: recentRows.map((row) => ({
        id: row.id,
        metadataType: row.metadata_type,
        title: row.title || row.original_title || '',
        year: row.year,
        addedAt: formatTimestamp(row.added_at),
        libraryName: row.library_name,
        libraryType: row.library_type,
      })),
      libraries: this.listLibraries(),
    }
  }

  facets(category, sectionId = null) {
    const { conditions, params } = this._baseConditions({
      category,
      sectionId,
      includeSearch: false,
    })
    const where = conditions.join(' AND ')
    return {
      genres: this.all(
        `
        SELECT t.tag AS value, COUNT(*) AS count
        FROM metadata_items mi
        LEFT JOIN library_sections ls ON ls.id = mi.library_section_id
        JOIN taggings tg ON tg.metadata_item_id = mi.id
        JOIN tags t ON t.id = tg.tag_id
        WHERE ${where}
          AND t.tag_type = 1
        GROUP BY t.tag
        ORDER BY count DESC, value ASC
        LIMIT 50
      `,
        params,
      ),
      years: this.all(
        `
        SELECT mi.year AS value, COUNT(*) AS count
        FROM metadata_items mi
        LEFT JOIN library_sections ls ON ls.id = mi.library_section_id
        WHERE ${where}
          AND mi.year IS NOT NULL
        GROUP BY mi.year
        ORDER BY value DESC
        LIMIT 50
      `,
        params,
      ),
      sections: this.all(
        `
        SELECT ls.id AS value, ls.name, ls.section_type, COUNT(mi.id) AS count
        FROM metadata_items mi
        LEFT JOIN library_sections ls ON ls.id = mi.library_section_id
        WHERE ${where}
        GROUP BY ls.id
        ORDER BY ls.section_type, ls.name
      `,
        params,
      ),
    }
  }

  listItems({ category = 'all', query = null, genre = null, year = null, sectionId = null, sort = 'title', direction = 'asc', page = 1, pageSize = 50 } = {}) {
    const { conditions, params } = this._baseConditions({
      category,
      sectionId,
      genre,
      year,
      query,
    })
    const where = conditions.join(' AND ')
    const orderClause = sortClause(sort, direction)
    const offset = Math.max(page - 1, 0) * pageSize

    const total = this.get(
      `
      SELECT COUNT(*) AS count
      FROM metadata_items mi
      LEFT JOIN library_sections ls ON ls.id = mi.library_section_id
      WHERE ${where}
    `,
      params,
    )?.count || 0

    const rows = this.all(
      `
      ${this._selectClause(true)}
      WHERE ${where}
      ORDER BY ${orderClause}
      LIMIT ? OFFSET ?
    `,
      [...params, pageSize, offset],
    )

    return {
      items: rows.map((row) => this._itemRow(row)),
      total,
      page,
      pageSize,
      hasMore: offset + pageSize < total,
    }
  }

  detailFiles(metadataItemId) {
    return this.all(
      `
      SELECT
        mp.id,
        mp.file,
        mp.size,
        mp.duration,
        mp."index" AS part_index,
        d.path AS directory_path
      FROM media_items mi
      JOIN media_parts mp ON mp.media_item_id = mi.id
      LEFT JOIN directories d ON d.id = mp.directory_id
      WHERE mi.metadata_item_id = ?
        AND mp.deleted_at IS NULL
      ORDER BY mp.id
    `,
      [metadataItemId],
    ).map((row) => ({
      id: row.id,
      file: row.file,
      directoryPath: row.directory_path,
      path: row.directory_path ? `${row.directory_path}/${row.file}` : row.file,
      size: row.size,
      durationMinutes: msToMinutes(row.duration),
      index: row.part_index,
    }))
  }

  fetchGenres(itemId) {
    return this.all(
      `
      SELECT DISTINCT t.tag
      FROM tags t
      JOIN taggings tg ON tg.tag_id = t.id
      WHERE tg.metadata_item_id = ?
        AND t.tag_type = 1
      ORDER BY t.tag
    `,
      [itemId],
    ).map((row) => row.tag)
  }

  movieDetail(itemId) {
    const row = this.get(
      `
      SELECT
        mi.*,
        ls.name AS library_name,
        ls.section_type AS library_type
      FROM metadata_items mi
      LEFT JOIN library_sections ls ON ls.id = mi.library_section_id
      WHERE mi.id = ?
        AND mi.metadata_type = ?
        AND mi.deleted_at IS NULL
    `,
      [itemId, MOVIE],
    )
    if (!row) return null
    const item = this._itemRow(row)
    item.files = this.detailFiles(itemId)
    item.genres = this.fetchGenres(itemId)
    return item
  }

  showDetail(itemId) {
    const row = this.get(
      `
      SELECT
        mi.*,
        ls.name AS library_name,
        ls.section_type AS library_type
      FROM metadata_items mi
      LEFT JOIN library_sections ls ON ls.id = mi.library_section_id
      WHERE mi.id = ?
        AND mi.metadata_type = ?
        AND mi.deleted_at IS NULL
    `,
      [itemId, SHOW],
    )
    if (!row) return null
    const item = this._itemRow(row)
    item.genres = this.fetchGenres(itemId)

    const seasons = this.all(
      `
      SELECT
        season.id,
        season."index" AS season_number,
        season.title,
        season.title_sort,
        season.original_title,
        season.summary,
        season.year,
        COUNT(episode.id) AS episode_count
      FROM metadata_items season
      LEFT JOIN metadata_items episode
        ON episode.parent_id = season.id
       AND episode.metadata_type = ?
       AND episode.deleted_at IS NULL
      WHERE season.parent_id = ?
        AND season.metadata_type = ?
        AND season.deleted_at IS NULL
      GROUP BY season.id
      ORDER BY season."index", season.id
    `,
      [EPISODE, itemId, SEASON],
    )

    const seasonIds = seasons.map((season) => season.id)
    const episodesBySeason = Object.fromEntries(seasonIds.map((id) => [id, []]))
    if (seasonIds.length) {
      const rows = this.all(
        `
        SELECT
          ep.id,
          ep.parent_id AS season_id,
          ep."index" AS episode_number,
          ep.absolute_index,
          ep.title,
          ep.original_title,
          ep.summary,
          ep.year,
          ep.added_at,
          ep.originally_available_at,
          ep.media_item_count
        FROM metadata_items ep
        WHERE ep.parent_id IN (${seasonIds.map(() => '?').join(',')})
          AND ep.metadata_type = ?
          AND ep.deleted_at IS NULL
        ORDER BY ep.parent_id, ep."index", ep.absolute_index, ep.id
      `,
        [...seasonIds, EPISODE],
      )
      for (const episode of rows) {
        episodesBySeason[episode.season_id].push({
          id: episode.id,
          seasonId: episode.season_id,
          episodeNumber: episode.episode_number,
          absoluteIndex: episode.absolute_index,
          title: episode.title || episode.original_title || '',
          originalTitle: episode.original_title,
          summary: episode.summary,
          year: episode.year,
          addedAt: formatTimestamp(episode.added_at),
          originallyAvailableAt: formatTimestamp(episode.originally_available_at),
          mediaItemCount: episode.media_item_count,
          files: this.detailFiles(episode.id),
        })
      }
    }

    item.seasons = seasons.map((season) => ({
      id: season.id,
      seasonNumber: season.season_number,
      title: season.title || `Season ${season.season_number}`,
      titleSort: season.title_sort,
      originalTitle: season.original_title,
      summary: season.summary,
      year: season.year,
      episodeCount: season.episode_count,
      episodes: episodesBySeason[season.id] || [],
    }))
    return item
  }

  artistDetail(itemId) {
    const row = this.get(
      `
      SELECT
        mi.*,
        ls.name AS library_name,
        ls.section_type AS library_type
      FROM metadata_items mi
      LEFT JOIN library_sections ls ON ls.id = mi.library_section_id
      WHERE mi.id = ?
        AND mi.metadata_type = ?
        AND mi.deleted_at IS NULL
    `,
      [itemId, ARTIST],
    )
    if (!row) return null
    const item = this._itemRow(row)
    item.genres = this.fetchGenres(itemId)

    const albums = this.all(
      `
      SELECT
        album.id,
        album.parent_id AS artist_id,
        album.title,
        album.title_sort,
        album.original_title,
        album.year,
        album.summary,
        album.added_at,
        COUNT(track.id) AS track_count
      FROM metadata_items album
      LEFT JOIN metadata_items track
        ON track.parent_id = album.id
       AND track.metadata_type = ?
       AND track.deleted_at IS NULL
      WHERE album.parent_id = ?
        AND album.metadata_type = ?
        AND album.deleted_at IS NULL
      GROUP BY album.id
      ORDER BY album.title_sort, album.id
    `,
      [TRACK, itemId, ALBUM],
    )

    const albumIds = albums.map((album) => album.id)
    const tracksByAlbum = Object.fromEntries(albumIds.map((id) => [id, []]))
    if (albumIds.length) {
      const rows = this.all(
        `
        SELECT
          track.id,
          track.parent_id AS album_id,
          track."index" AS track_number,
          track.absolute_index,
          track.title,
          track.original_title,
          track.summary,
          track.year,
          track.added_at,
          track.originally_available_at,
          track.media_item_count
        FROM metadata_items track
        WHERE track.parent_id IN (${albumIds.map(() => '?').join(',')})
          AND track.metadata_type = ?
          AND track.deleted_at IS NULL
        ORDER BY track.parent_id, track."index", track.absolute_index, track.id
      `,
        [...albumIds, TRACK],
      )
      for (const track of rows) {
        tracksByAlbum[track.album_id].push({
          id: track.id,
          albumId: track.album_id,
          trackNumber: track.track_number,
          absoluteIndex: track.absolute_index,
          title: track.title || track.original_title || '',
          originalTitle: track.original_title,
          summary: track.summary,
          year: track.year,
          addedAt: formatTimestamp(track.added_at),
          originallyAvailableAt: formatTimestamp(track.originally_available_at),
          mediaItemCount: track.media_item_count,
          files: this.detailFiles(track.id),
        })
      }
    }

    item.albums = albums.map((album) => ({
      id: album.id,
      artistId: album.artist_id,
      title: album.title || '',
      titleSort: album.title_sort,
      originalTitle: album.original_title,
      summary: album.summary,
      year: album.year,
      addedAt: formatTimestamp(album.added_at),
      trackCount: album.track_count,
      tracks: tracksByAlbum[album.id] || [],
    }))
    return item
  }

  albumDetail(itemId) {
    const row = this.get(
      `
      SELECT
        album.*,
        album.title AS artist_title,
        artist.title AS parent_artist_title,
        artist.original_title AS parent_artist_original_title,
        ls.name AS library_name,
        ls.section_type AS library_type
      FROM metadata_items album
      JOIN metadata_items artist ON artist.id = album.parent_id
      LEFT JOIN library_sections ls ON ls.id = album.library_section_id
      WHERE album.id = ?
        AND album.metadata_type = ?
        AND album.deleted_at IS NULL
    `,
      [itemId, ALBUM],
    )
    if (!row) return null

    const item = this._itemRow(row)
    item.artistTitle = row.parent_artist_title
    item.artistOriginalTitle = row.parent_artist_original_title
    item.genres = this.fetchGenres(itemId)

    const tracks = this.all(
      `
      SELECT
        track.id,
        track.parent_id AS album_id,
        track."index" AS track_number,
        track.absolute_index,
        track.title,
        track.original_title,
        track.summary,
        track.year,
        track.added_at,
        track.originally_available_at,
        track.media_item_count
      FROM metadata_items track
      WHERE track.parent_id = ?
        AND track.metadata_type = ?
        AND track.deleted_at IS NULL
      ORDER BY track."index", track.absolute_index, track.id
    `,
      [itemId, TRACK],
    )

    item.tracks = tracks.map((track) => ({
      id: track.id,
      albumId: track.album_id,
      trackNumber: track.track_number,
      absoluteIndex: track.absolute_index,
      title: track.title || track.original_title || '',
      originalTitle: track.original_title,
      summary: track.summary,
      year: track.year,
      addedAt: formatTimestamp(track.added_at),
      originallyAvailableAt: formatTimestamp(track.originally_available_at),
      mediaItemCount: track.media_item_count,
      files: this.detailFiles(track.id),
    }))
    item.folderPaths = [...new Set(item.tracks.flatMap((track) => track.files.map((file) => file.directoryPath).filter(Boolean)))].sort()
    item.files = item.tracks.flatMap((track) => track.files)
    return item
  }

  duplicateAlbums({ query = null, year = null, sectionId = null, genre = null } = {}) {
    const conditions = ['album.deleted_at IS NULL', 'album.metadata_type = ?', 'ls.section_type = ?']
    const params = [ALBUM, 8]

    if (sectionId !== null && sectionId !== undefined && sectionId !== '') {
      conditions.push('album.library_section_id = ?')
      params.push(sectionId)
    }

    if (year !== null && year !== undefined && year !== '') {
      conditions.push('album.year = ?')
      params.push(year)
    }

    if (genre) {
      conditions.push(`
        EXISTS (
          SELECT 1
          FROM tags t
          JOIN taggings tg ON tg.tag_id = t.id
          WHERE tg.metadata_item_id = album.id
            AND t.tag_type = 1
            AND lower(t.tag) = lower(?)
        )
      `)
      params.push(genre)
    }

    if (query) {
      conditions.push(`
        (
          lower(coalesce(album.title, '')) LIKE ?
          OR lower(coalesce(album.original_title, '')) LIKE ?
          OR lower(coalesce(artist.title, '')) LIKE ?
          OR lower(coalesce(artist.original_title, '')) LIKE ?
        )
      `)
      const likeQuery = `%${escapeLike(String(query).toLowerCase())}%`
      params.push(likeQuery, likeQuery, likeQuery, likeQuery)
    }

    const rows = this.all(
      `
      SELECT
        album.id,
        album.title,
        album.title_sort,
        album.original_title,
        album.year,
        album.added_at,
        album.library_section_id,
        ls.name AS library_name,
        ls.section_type AS library_type,
        artist.id AS artist_id,
        artist.title AS artist_title,
        artist.original_title AS artist_original_title,
        COUNT(DISTINCT track.id) AS track_count,
        COUNT(DISTINCT d.path) AS folder_count,
        (
          SELECT GROUP_CONCAT(path, '||')
          FROM (
            SELECT DISTINCT d2.path AS path
            FROM metadata_items track2
            LEFT JOIN media_items mi2
              ON mi2.metadata_item_id = track2.id
             AND mi2.deleted_at IS NULL
            LEFT JOIN media_parts mp2
              ON mp2.media_item_id = mi2.id
             AND mp2.deleted_at IS NULL
            LEFT JOIN directories d2
              ON d2.id = mp2.directory_id
             AND d2.deleted_at IS NULL
            WHERE track2.parent_id = album.id
              AND track2.metadata_type = ?
              AND track2.deleted_at IS NULL
              AND d2.path IS NOT NULL
            ORDER BY path
          )
        ) AS folder_paths
      FROM metadata_items album
      JOIN metadata_items artist ON artist.id = album.parent_id
      LEFT JOIN library_sections ls ON ls.id = album.library_section_id
      LEFT JOIN metadata_items track
        ON track.parent_id = album.id
       AND track.metadata_type = ?
       AND track.deleted_at IS NULL
      LEFT JOIN media_items mi
        ON mi.metadata_item_id = track.id
       AND mi.deleted_at IS NULL
      LEFT JOIN media_parts mp
        ON mp.media_item_id = mi.id
       AND mp.deleted_at IS NULL
      LEFT JOIN directories d
        ON d.id = mp.directory_id
       AND d.deleted_at IS NULL
      WHERE ${conditions.join(' AND ')}
      GROUP BY album.id
      HAVING 1 = 1
      ORDER BY lower(coalesce(artist.title, artist.original_title, '')),
               lower(coalesce(album.title, album.original_title, '')),
               album.year,
               album.added_at,
               album.id
    `,
      [TRACK, TRACK, ...params],
    )

    const groups = new Map()
    for (const row of rows) {
      const artistKey = String(row.artist_original_title || row.artist_title || '').trim().toLowerCase()
      const albumKey = String(row.original_title || row.title || '').trim().toLowerCase()
      const key = `${artistKey}::${albumKey}`
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          artistTitle: row.artist_title || row.artist_original_title || 'Unknown artist',
          albumTitle: row.title || row.original_title || 'Unknown album',
          duplicateCount: 0,
          totalTrackCount: 0,
          albums: [],
        })
      }
      const group = groups.get(key)
      const folderPaths = row.folder_paths ? String(row.folder_paths).split('||').filter(Boolean) : []
      group.albums.push({
        id: row.id,
        metadataType: ALBUM,
        title: row.title || row.original_title || '',
        titleSort: row.title_sort,
        originalTitle: row.original_title,
        year: row.year,
        addedAt: formatTimestamp(row.added_at),
        librarySectionId: row.library_section_id,
        libraryName: row.library_name,
        libraryType: row.library_type,
        artistId: row.artist_id,
        artistTitle: row.artist_title,
        artistOriginalTitle: row.artist_original_title,
        trackCount: row.track_count,
        folderCount: row.folder_count,
        folderPaths,
        primaryFolderPath: folderPaths[0] || null,
        hasMissingMetadata: !Boolean(row.title || row.original_title),
      })
      group.duplicateCount += 1
      group.totalTrackCount += row.track_count || 0
    }

    return [...groups.values()]
      .filter((group) => group.duplicateCount > 1)
      .sort((a, b) => {
        if (b.duplicateCount !== a.duplicateCount) return b.duplicateCount - a.duplicateCount
        const artistDiff = a.artistTitle.toLowerCase().localeCompare(b.artistTitle.toLowerCase())
        if (artistDiff !== 0) return artistDiff
        return a.albumTitle.toLowerCase().localeCompare(b.albumTitle.toLowerCase())
      })
  }

  exportItems(options = {}) {
    const payload = this.listItems({ ...options, page: 1, pageSize: 100000 })
    return payload.items
  }
}

async function sessionFromRecord(record) {
  const SQL = await getSql()
  const db = new SQL.Database(new Uint8Array(record.dbBytes))
  return {
    token: record.token,
    fileName: record.originalName,
    sizeBytes: record.sizeBytes,
    db,
    repo: new PlexRepository(db),
  }
}

async function ensureSession(token) {
  if (currentSession?.token === token) {
    return currentSession
  }
  if (!token) {
    throw new Error('Session not found. Upload a database first.')
  }
  const record = await loadSessionRecord(token)
  if (!record) {
    throw new Error('Session not found. Upload a database first.')
  }
  currentSession = await sessionFromRecord(record)
  return currentSession
}

function blobUrlFromText(text, type) {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  window.setTimeout(() => URL.revokeObjectURL(url), 60000)
  return url
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`
  }
  return text
}

function itemsToCsv(items) {
  const headers = [...new Set(items.flatMap((item) => Object.keys(item)))]
  const lines = [headers.map(csvEscape).join(',')]
  for (const item of items) {
    lines.push(headers.map((header) => csvEscape(item[header])).join(','))
  }
  return lines.join('\n')
}

function duplicateAlbumsToCsv(groups) {
  const rows = []
  for (const group of groups) {
    for (const album of group.albums || []) {
      rows.push({
        duplicateGroup: group.key,
        artistTitle: group.artistTitle,
        albumTitle: group.albumTitle,
        duplicateCount: group.duplicateCount,
        totalTrackCount: group.totalTrackCount,
        albumId: album.id,
        title: album.title,
        year: album.year,
        libraryName: album.libraryName,
        primaryFolderPath: album.primaryFolderPath || '',
        folderPaths: (album.folderPaths || []).join(' | '),
        trackCount: album.trackCount,
      })
    }
  }
  return itemsToCsv(rows)
}

export async function uploadDatabase(file) {
  const { db, bytes, sizeBytes } = await createDatabaseFromFile(file)
  const token = randomToken()
  const session = {
    token,
    fileName: file.name || 'plex.db',
    sizeBytes,
    db,
    repo: new PlexRepository(db),
  }
  currentSession = session
  await persistSessionRecord({
    token,
    originalName: session.fileName,
    sizeBytes,
    dbBytes: bytes,
  })
  return {
    token,
    fileName: session.fileName,
    sizeBytes,
    summary: session.repo.summary(),
    libraries: session.repo.listLibraries(),
  }
}

export async function getSummary(token) {
  return (await ensureSession(token)).repo.summary()
}

export async function getLibraries(token) {
  return (await ensureSession(token)).repo.listLibraries()
}

export async function getFacets(token, params) {
  return (await ensureSession(token)).repo.facets(params?.category, params?.section_id ?? null)
}

export async function getItems(token, params) {
  return (await ensureSession(token)).repo.listItems({
    category: params?.category,
    query: params?.query,
    genre: params?.genre,
    year: params?.year,
    sectionId: params?.section_id ?? null,
    sort: params?.sort,
    direction: params?.direction,
    page: params?.page,
    pageSize: params?.page_size,
  })
}

export async function getMovie(token, id) {
  return (await ensureSession(token)).repo.movieDetail(id)
}

export async function getShow(token, id) {
  return (await ensureSession(token)).repo.showDetail(id)
}

export async function getArtist(token, id) {
  return (await ensureSession(token)).repo.artistDetail(id)
}

export async function getAlbum(token, id) {
  return (await ensureSession(token)).repo.albumDetail(id)
}

export async function getMusicDuplicates(token, params) {
  return (await ensureSession(token)).repo.duplicateAlbums({
    query: params?.query,
    year: params?.year,
    sectionId: params?.section_id ?? null,
    genre: params?.genre,
  })
}

export async function exportUrl(token, params) {
  const session = await ensureSession(token)
  const format = String(params?.format || 'json').toLowerCase()
  if (format === 'duplicates-csv') {
    const duplicateGroups = session.repo.duplicateAlbums({
      query: params?.query,
      year: params?.year,
      sectionId: params?.section_id ?? null,
      genre: params?.genre,
    })
    return blobUrlFromText(duplicateAlbumsToCsv(duplicateGroups), 'text/csv')
  }
  const items = session.repo.exportItems({
    category: params?.category,
    query: params?.query,
    genre: params?.genre,
    year: params?.year,
    sectionId: params?.section_id ?? null,
    sort: params?.sort,
    direction: params?.direction,
  })
  if (format === 'csv') {
    return blobUrlFromText(itemsToCsv(items), 'text/csv')
  }
  return blobUrlFromText(JSON.stringify(items, null, 2), 'application/json')
}

export async function deleteSession(token) {
  if (currentSession?.token === token) {
    currentSession.db.close()
    currentSession = null
  }
  await deleteSessionRecord(token)
  return { status: 'deleted' }
}

export async function restoreSession(token) {
  return ensureSession(token)
}

export async function clearAllSessions() {
  if (currentSession) {
    currentSession.db.close()
    currentSession = null
  }
  await clearAllSessionRecords()
}
