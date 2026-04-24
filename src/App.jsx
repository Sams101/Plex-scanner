import React, { useEffect, useMemo, useState } from 'react'
import {
  deleteSession,
  exportUrl,
  getAlbum,
  getArtist,
  getFacets,
  getItems,
  getLibraries,
  getMusicDuplicates,
  getMovie,
  getShow,
  getSummary,
  restoreSession,
  uploadDatabase,
} from './api'

const CATEGORY_OPTIONS = [
  { id: 'all', label: 'All media' },
  { id: 'movies', label: 'Movies' },
  { id: 'shows', label: 'TV shows' },
  { id: 'music', label: 'Music' },
]

function formatDate(value) {
  if (!value) return 'Unknown'
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(value))
  } catch {
    return value
  }
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value || 0)
}

function prettyType(type) {
  switch (type) {
    case 1:
      return 'Movie'
    case 2:
      return 'Show'
    case 3:
      return 'Season'
    case 4:
      return 'Episode'
    case 8:
      return 'Artist'
    case 9:
      return 'Album'
    case 10:
      return 'Track'
    default:
      return 'Item'
  }
}

function groupPreviewItems(items) {
  const groups = new Map()
  for (const item of items) {
    const key = prettyType(item.metadataType)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  return [
    ['Movie', groups.get('Movie') || []],
    ['Show', groups.get('Show') || []],
    ['Artist', groups.get('Artist') || []],
    ['Album', groups.get('Album') || []],
    ['Track', groups.get('Track') || []],
  ]
}

function mergeUniqueItems(...lists) {
  const seen = new Set()
  const merged = []
  for (const list of lists) {
    for (const item of list || []) {
      const key = `${item.metadataType}-${item.id}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(item)
    }
  }
  return merged
}

export default function App() {
  const [sessionToken, setSessionToken] = useState(() => sessionStorage.getItem('plex-session-token') || '')
  const [sessionMeta, setSessionMeta] = useState(null)
  const [summary, setSummary] = useState(null)
  const [libraries, setLibraries] = useState([])
  const [facets, setFacets] = useState({ genres: [], years: [], sections: [] })
  const [items, setItems] = useState([])
  const [allMediaItems, setAllMediaItems] = useState([])
  const [duplicateGroups, setDuplicateGroups] = useState([])
  const [selected, setSelected] = useState(null)
  const [selectedDetail, setSelectedDetail] = useState(null)
  const [allMediaMode, setAllMediaMode] = useState('preview')
  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  const [genre, setGenre] = useState('')
  const [year, setYear] = useState('')
  const [sectionId, setSectionId] = useState('')
  const [sort, setSort] = useState('title')
  const [direction, setDirection] = useState('asc')
  const [page, setPage] = useState(1)
  const [pageSize] = useState(50)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [uploadName, setUploadName] = useState('')

  async function loadSession(token, nextCategory = category) {
    setLoading(true)
    setError('')
    try {
      const session = await restoreSession(token)
      const requests = [
        getSummary(token),
        getLibraries(token),
        getFacets(token, { category: nextCategory, section_id: sectionId || undefined }),
        getItems(token, {
          category: nextCategory,
          query,
          genre,
          year,
          section_id: sectionId || undefined,
          sort,
          direction,
          page,
          page_size: pageSize,
        }),
        nextCategory === 'music'
          ? getMusicDuplicates(token, {
              query,
              genre,
              year,
              section_id: sectionId || undefined,
            })
          : Promise.resolve([]),
      ]
      if (nextCategory === 'all') {
        requests.push(
          getItems(token, {
            category: 'movies',
            query,
            genre,
            year,
            section_id: sectionId || undefined,
            sort,
            direction,
            page: 1,
            page_size: 3,
          }),
          getItems(token, {
            category: 'shows',
            query,
            genre,
            year,
            section_id: sectionId || undefined,
            sort,
            direction,
            page: 1,
            page_size: 3,
          }),
          getItems(token, {
            category: 'music',
            query,
            genre,
            year,
            section_id: sectionId || undefined,
            sort,
            direction,
            page: 1,
            page_size: 3,
          }),
        )
      }
      const results = await Promise.all(requests)
      const [summaryData, librariesData, facetsData, itemsData, duplicateGroupsData, moviePreviewData, showPreviewData, musicPreviewData] = results
      setSessionMeta({
        token,
        fileName: session.fileName,
        sizeBytes: session.sizeBytes,
      })
      setSummary(summaryData)
      setLibraries(librariesData)
      setFacets(facetsData)
      const fullItems = itemsData.items
      const previewItems =
        nextCategory === 'all'
          ? mergeUniqueItems(
              moviePreviewData?.items,
              showPreviewData?.items,
              musicPreviewData?.items,
            )
          : fullItems
      if (nextCategory !== 'all') {
        setAllMediaMode('preview')
      }
      setAllMediaItems(fullItems)
      setItems(previewItems)
      setDuplicateGroups(duplicateGroupsData)
      setTotal(itemsData.total)
      if (nextCategory === 'music') {
        const firstAlbum = duplicateGroupsData[0]?.albums?.[0] || null
        setSelected(firstAlbum || previewItems[0] || null)
      } else if (previewItems.length) {
        setSelected(previewItems[0])
      } else {
        setSelected(null)
        setSelectedDetail(null)
      }
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (sessionToken) {
      loadSession(sessionToken, category)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!sessionToken) return
    const timer = window.setTimeout(() => {
      loadSession(sessionToken, category)
    }, 250)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, query, genre, year, sectionId, sort, direction, page])

  useEffect(() => {
    if (!sessionToken || !selected) return
    let cancelled = false
    async function loadDetail() {
      try {
        const detail =
          selected.metadataType === 1
            ? await getMovie(sessionToken, selected.id)
            : selected.metadataType === 2
              ? await getShow(sessionToken, selected.id)
              : selected.metadataType === 8
                ? await getArtist(sessionToken, selected.id)
                : selected.metadataType === 9
                  ? await getAlbum(sessionToken, selected.id)
                : selected
        if (!cancelled) setSelectedDetail(detail)
      } catch (err) {
        if (!cancelled) setSelectedDetail({ error: err.message || String(err) })
      }
    }
    loadDetail()
    return () => {
      cancelled = true
    }
  }, [sessionToken, selected])

  const currentCategoryLabel = useMemo(
    () => CATEGORY_OPTIONS.find((option) => option.id === category)?.label || 'All media',
    [category],
  )

  async function handleUpload(event) {
    const file = event.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError('')
    setUploadName(file.name)
    try {
      const result = await uploadDatabase(file)
      sessionStorage.setItem('plex-session-token', result.token)
      setSessionToken(result.token)
      await loadSession(result.token, category)
      setSessionMeta({ token: result.token, fileName: result.fileName, sizeBytes: result.sizeBytes })
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setUploading(false)
      event.target.value = ''
    }
  }

  async function clearSession() {
    if (!sessionToken) return
    try {
      await deleteSession(sessionToken)
    } catch {
      // Ignore delete failures and clear client state anyway.
    }
    sessionStorage.removeItem('plex-session-token')
    setSessionToken('')
    setSessionMeta(null)
    setSummary(null)
    setLibraries([])
    setFacets({ genres: [], years: [], sections: [] })
    setItems([])
    setDuplicateGroups([])
    setSelected(null)
    setSelectedDetail(null)
    setTotal(0)
  }

  async function openExport(format) {
    if (!sessionToken) return
    try {
      const url = await exportUrl(sessionToken, {
        category,
        query,
        genre,
        year,
        section_id: sectionId || undefined,
        sort,
        direction,
        format,
      })
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      setError(err.message || String(err))
    }
  }

  async function openDuplicateExport() {
    if (!sessionToken || category !== 'music') return
    try {
      const url = await exportUrl(sessionToken, {
        category,
        query,
        genre,
        year,
        section_id: sectionId || undefined,
        format: 'duplicates-csv',
      })
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      setError(err.message || String(err))
    }
  }

  return (
    <div className="shell">
      <div className="aurora" />
      <header className="topbar">
        <div>
          <p className="eyebrow">Plex SQLite explorer</p>
          <h1>Plex Scanner</h1>
          <p className="lede">
            Scan a Plex database, filter fast, and inspect the catalog without touching the source file.
          </p>
        </div>
        <div className="upload-card">
          <label className="upload-button">
            <input type="file" accept=".db,.sqlite,.sqlite3" onChange={handleUpload} />
            {uploading ? 'Uploading…' : 'Upload SQLite database'}
          </label>
          <div className="upload-meta">
            <span>{uploadName || 'No file selected'}</span>
            <span>{sessionMeta?.fileName || sessionToken ? 'Session active' : 'Waiting for upload'}</span>
          </div>
          <button className="ghost-button subtle-button" onClick={clearSession} disabled={!sessionToken}>
            Clear session
          </button>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      {summary ? (
        <section className="content-grid">
          <aside className="sidebar">
            <div className="panel panel-flat">
              <div className="panel-head">
                <h2>Browse</h2>
                <span>{currentCategoryLabel}</span>
              </div>
              <div className="tab-row">
                {CATEGORY_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    className={option.id === category ? 'tab active' : 'tab'}
                    onClick={() => {
                      setCategory(option.id)
                      setAllMediaMode('preview')
                      setSectionId('')
                      setGenre('')
                      setYear('')
                      setPage(1)
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="panel panel-flat">
              <label className="field">
                <span>Search</span>
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setPage(1)
                  }}
                  placeholder="Title, summary, original title"
                />
              </label>
              <div className="two-up">
                <label className="field">
                  <span>Genre</span>
                  <select
                    value={genre}
                    onChange={(e) => {
                      setGenre(e.target.value)
                      setPage(1)
                    }}
                  >
                    <option value="">All genres</option>
                    {facets.genres.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.value} ({option.count})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Year</span>
                  <select
                    value={year}
                    onChange={(e) => {
                      setYear(e.target.value)
                      setPage(1)
                    }}
                  >
                    <option value="">Any</option>
                    {facets.years.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.value} ({option.count})
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="field">
                <span>Library section</span>
                <select
                  value={sectionId}
                  onChange={(e) => {
                    setSectionId(e.target.value)
                    setPage(1)
                  }}
                >
                  <option value="">All sections</option>
                  {facets.sections.map((section) => (
                    <option key={section.value} value={section.value}>
                      {section.name || section.value} ({section.count})
                    </option>
                  ))}
                </select>
              </label>
              <div className="two-up">
                <label className="field">
                  <span>Sort by</span>
                  <select
                    value={sort}
                    onChange={(e) => {
                      setSort(e.target.value)
                      setPage(1)
                    }}
                  >
                    <option value="title">Title</option>
                    <option value="year">Release year</option>
                    <option value="date_added">Date added</option>
                  </select>
                </label>
                <label className="field">
                  <span>Direction</span>
                  <select
                    value={direction}
                    onChange={(e) => {
                      setDirection(e.target.value)
                      setPage(1)
                    }}
                  >
                    <option value="asc">Ascending</option>
                    <option value="desc">Descending</option>
                  </select>
                </label>
              </div>
              <div className="action-row">
                <button className="ghost-button" onClick={() => openExport('json')}>
                  Export JSON
                </button>
                <button className="ghost-button" onClick={() => openExport('csv')}>
                  Export CSV
                </button>
                {category === 'music' ? (
                  <button className="ghost-button" onClick={openDuplicateExport}>
                    Export duplicates CSV
                  </button>
                ) : null}
              </div>
            </div>

            <div className="panel panel-flat panel-stats">
              <div className="panel-head">
                <h2>Statistics</h2>
                <span>Library totals</span>
              </div>
              <div className="stats-grid">
                <article className="metric-card">
                  <span>Movies</span>
                  <strong>{formatNumber(summary.counts.movies)}</strong>
                </article>
                <article className="metric-card">
                  <span>Shows</span>
                  <strong>{formatNumber(summary.counts.shows)}</strong>
                </article>
                <article className="metric-card">
                  <span>Artists</span>
                  <strong>{formatNumber(summary.counts.artists)}</strong>
                </article>
                <article className="metric-card">
                  <span>Albums</span>
                  <strong>{formatNumber(summary.counts.albums)}</strong>
                </article>
              </div>
            </div>
          </aside>

          <div className="content-column">
            <main className="main-panel">
              <div className="panel panel-stage">
                <div className="panel-head">
                  <h2>{category === 'music' ? 'Music library' : currentCategoryLabel}</h2>
                  <span>{category === 'music' ? `${formatNumber(total)} artists` : `${formatNumber(total)} matches`}</span>
                </div>

                {category === 'all' ? (
                  <div className="mode-switch" role="tablist" aria-label="All media view">
                    <button
                      className={allMediaMode === 'preview' ? 'mode-switch-button active' : 'mode-switch-button'}
                      onClick={() => setAllMediaMode('preview')}
                    >
                      Preview
                    </button>
                    <button
                      className={allMediaMode === 'full' ? 'mode-switch-button active' : 'mode-switch-button'}
                      onClick={() => setAllMediaMode('full')}
                    >
                      Full list
                    </button>
                  </div>
                ) : null}

                {loading ? <div className="empty-state">Loading Plex data…</div> : null}

                {category === 'music' ? (
                  <>
                    {items.length ? (
                      <>
                        <p className="muted">
                          Showing the current music library preview. Select an artist to inspect its albums and tracks.
                        </p>
                        <div className="compact-grid">
                        {items.slice(0, 8).map((item) => (
                          <button
                            key={`${item.metadataType}-${item.id}`}
                            className={selected?.id === item.id && selected?.metadataType === item.metadataType ? 'result-card active' : 'result-card'}
                            onClick={() => setSelected(item)}
                          >
                            <div className="result-meta">
                              <span className="card-label">{prettyType(item.metadataType)}</span>
                              <span>{item.libraryName}</span>
                            </div>
                            <h3>{item.title}</h3>
                            <div className="result-footer">
                              <span>{item.year || 'Unknown year'}</span>
                                <span>{item.genres?.length ? item.genres.join(', ') : 'No genre tags'}</span>
                              </div>
                            </button>
                          ))}
                        </div>
                        {items.length > 8 ? <div className="empty-state">Showing the first 8 music items only.</div> : null}
                      </>
                    ) : (
                      <div className="empty-state">No music items found for the current filters.</div>
                    )}

                    <section className="subpanel music-duplicates-panel">
                      <div className="panel-head">
                        <h3>Duplicate albums</h3>
                        <span>{duplicateGroups.length} duplicate groups</span>
                      </div>
                      {duplicateGroups.length ? (
                        <div className="duplicate-list">
                          {duplicateGroups.map((group) => (
                            <section key={group.key} className="duplicate-group">
                              <div className="duplicate-group-head">
                                <div>
                                  <span className="pill">Duplicate set</span>
                                  <h3>
                                    {group.artistTitle} - {group.albumTitle}
                                  </h3>
                                  <p>
                                    {group.duplicateCount} copies · {group.totalTrackCount} total tracks
                                  </p>
                                </div>
                              </div>
                              <div className="duplicate-album-list">
                                {group.albums.map((album) => (
                                <button
                                  key={album.id}
                                  className={selected?.id === album.id && selected?.metadataType === album.metadataType ? 'result-card active' : 'result-card'}
                                  onClick={() => setSelected(album)}
                                >
                                  <div className="result-meta">
                                      <span className="card-label">{album.libraryName}</span>
                                      <span>{album.year || 'Unknown year'}</span>
                                  </div>
                                    <h3>{album.title}</h3>
                                    <p>{album.primaryFolderPath || album.folderPaths?.[0] || 'No folder path found'}</p>
                                    <div className="result-footer">
                                      <span>{album.trackCount} tracks</span>
                                      <span>{album.folderCount || album.folderPaths?.length || 0} folder(s)</span>
                                    </div>
                                  </button>
                                ))}
                              </div>
                            </section>
                          ))}
                        </div>
                      ) : (
                        <div className="empty-state">No duplicate albums found for the current filters.</div>
                      )}
                    </section>
                  </>
                ) : items.length ? (
                  <div key={`results-${category}-${allMediaMode}`} className="results-motion">
                    <p className="muted">
                      Showing a compact preview of the current filter. Narrow the sidebar filters if you want to inspect
                      a smaller set.
                    </p>
                    {allMediaMode === 'preview' ? (
                      <div className="media-preview-groups">
                        {groupPreviewItems(items).map(([label, groupItems]) =>
                          groupItems.length ? (
                            <section key={label} className="media-preview-group">
                              <div className="panel-head">
                                <h3>{label}s</h3>
                                <span>{groupItems.length}</span>
                              </div>
                              <div className="compact-grid">
                                {groupItems.slice(0, 3).map((item) => (
                                  <button
                                    key={`${item.metadataType}-${item.id}`}
                                    className={selected?.id === item.id && selected?.metadataType === item.metadataType ? 'result-card active' : 'result-card'}
                                    onClick={() => setSelected(item)}
                                  >
                                    <div className="result-meta">
                                      <span className="card-label">{prettyType(item.metadataType)}</span>
                                      <span>{item.libraryName}</span>
                                    </div>
                                    <h3>{item.title}</h3>
                                    <div className="result-footer">
                                      <span>{item.year || 'Unknown year'}</span>
                                      <span>{item.genres?.length ? item.genres.join(', ') : 'No genre tags'}</span>
                                    </div>
                                  </button>
                                ))}
                              </div>
                            </section>
                          ) : null,
                        )}
                      </div>
                    ) : (
                      <div className="media-full-selection">
                        {groupPreviewItems(allMediaItems).map(([label, groupItems]) =>
                          groupItems.length ? (
                            <section key={label} className="media-preview-group">
                              <div className="panel-head">
                                <h3>{label}s</h3>
                                <span>{groupItems.length}</span>
                              </div>
                              <div className="compact-grid">
                                {groupItems.map((item) => (
                                  <button
                                    key={`${item.metadataType}-${item.id}`}
                                    className={selected?.id === item.id && selected?.metadataType === item.metadataType ? 'result-card active' : 'result-card'}
                                    onClick={() => setSelected(item)}
                                  >
                                    <div className="result-meta">
                                      <span className="card-label">{prettyType(item.metadataType)}</span>
                                      <span>{item.libraryName}</span>
                                    </div>
                                    <h3>{item.title}</h3>
                                    <div className="result-footer">
                                      <span>{item.year || 'Unknown year'}</span>
                                      <span>{item.genres?.length ? item.genres.join(', ') : 'No genre tags'}</span>
                                    </div>
                                  </button>
                                ))}
                              </div>
                            </section>
                          ) : null,
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="empty-state">No matching items found.</div>
                )}
              </div>
            </main>

            <aside className="detail-panel">
              <div className="panel panel-inspector">
                <div className="panel-head">
                  <h2>Details</h2>
                  <span>{selected ? prettyType(selected.metadataType) : 'Nothing selected'}</span>
                </div>
                {!selected ? (
                  <div className="empty-state">Select an item to inspect its Plex metadata.</div>
                ) : selectedDetail?.error ? (
                  <div className="empty-state">{selectedDetail.error}</div>
                ) : selectedDetail ? (
                  <div key={`detail-${selected?.metadataType}-${selected?.id}`} className="detail-stack detail-motion">
                    <div>
                      <p className="eyebrow plain-text-label">{prettyType(selected.metadataType)}</p>
                      <h3>{selectedDetail.title}</h3>
                      <p className="muted">
                        {selected.metadataType === 9 && selectedDetail.artistTitle
                          ? `${selectedDetail.artistTitle} · `
                          : ''}
                        {selectedDetail.libraryName}
                      </p>
                    </div>
                    <dl className="detail-grid">
                      <div>
                        <dt>Year</dt>
                        <dd>{selectedDetail.year || 'Unknown'}</dd>
                      </div>
                      <div>
                        <dt>Added</dt>
                        <dd>{formatDate(selectedDetail.addedAt)}</dd>
                      </div>
                      <div>
                        <dt>Genres</dt>
                        <dd>{selectedDetail.genres?.length ? selectedDetail.genres.join(', ') : 'None'}</dd>
                      </div>
                      <div>
                        <dt>Summary</dt>
                        <dd>{selectedDetail.summary || 'No summary available'}</dd>
                      </div>
                    </dl>

                    {selected.metadataType === 1 ? (
                      <>
                        <section className="subpanel">
                          <h4>Files</h4>
                          {selectedDetail.files?.length ? (
                            selectedDetail.files.map((file) => (
                              <div key={file.id} className="file-row">
                                <strong>{file.path}</strong>
                                <span>{file.durationMinutes ? `${file.durationMinutes} min` : 'Unknown duration'}</span>
                              </div>
                            ))
                          ) : (
                            <p className="muted">No media parts found.</p>
                          )}
                        </section>
                      </>
                    ) : null}

                    {selected.metadataType === 2 ? (
                      <section className="subpanel">
                        <h4>Seasons</h4>
                        {selectedDetail.seasons?.map((season) => (
                          <details key={season.id} className="accordion">
                            <summary>
                              {season.title} · {season.episodeCount} episodes
                            </summary>
                            <div className="accordion-body">
                              {season.episodes.map((episode) => (
                                <div key={episode.id} className="episode-row">
                                  <strong>
                                    {episode.episodeNumber ? `E${episode.episodeNumber}` : 'Episode'} {episode.title}
                                  </strong>
                                  <span>{episode.summary || 'No summary'}</span>
                                </div>
                              ))}
                            </div>
                          </details>
                        ))}
                      </section>
                    ) : null}

                    {selected.metadataType === 8 ? (
                      <section className="subpanel">
                        <h4>Albums</h4>
                        {selectedDetail.albums?.map((album) => (
                          <details key={album.id} className="accordion">
                            <summary>
                              {album.title} · {album.trackCount} tracks
                            </summary>
                            <div className="accordion-body">
                              {album.tracks.map((track) => (
                                <div key={track.id} className="episode-row">
                                  <strong>
                                    {track.trackNumber ? `${track.trackNumber}. ` : ''}
                                    {track.title}
                                  </strong>
                                  <span>{track.summary || 'No summary'}</span>
                                </div>
                              ))}
                            </div>
                          </details>
                        ))}
                      </section>
                    ) : null}

                    {selected.metadataType === 9 ? (
                      <>
                        <section className="subpanel">
                          <h4>Storage paths</h4>
                          {selectedDetail.folderPaths?.length ? (
                            selectedDetail.folderPaths.map((path) => (
                              <div key={path} className="file-row">
                                <strong>{path}</strong>
                              </div>
                            ))
                          ) : (
                            <p className="muted">No folder path found for this album.</p>
                          )}
                        </section>
                        <section className="subpanel">
                          <h4>Tracks</h4>
                          {selectedDetail.tracks?.length ? (
                            selectedDetail.tracks.map((track) => (
                              <div key={track.id} className="episode-row">
                                <strong>
                                  {track.trackNumber ? `${track.trackNumber}. ` : ''}
                                  {track.title}
                                </strong>
                                <span>
                                  {track.files?.length
                                    ? track.files.map((file) => file.path).join(' | ')
                                    : 'No file path available'}
                                </span>
                              </div>
                            ))
                          ) : (
                            <p className="muted">No tracks found.</p>
                          )}
                        </section>
                      </>
                    ) : null}
                  </div>
                ) : (
                  <div className="empty-state">Loading item details…</div>
                )}
              </div>
            </aside>
          </div>
        </section>
      ) : (
        <section className="empty-landing">
          <div className="panel">
            <h2>Start with a Plex export</h2>
            <p>
              Upload the SQLite database from your Plex server. The app keeps it in the browser and queries it
              read-only.
            </p>
            <ul>
              <li>Large-file upload handled locally in the browser</li>
              <li>Catalog browsing with pagination and filters</li>
              <li>Read-only search over the Plex schema and FTS index</li>
            </ul>
          </div>
        </section>
      )}
    </div>
  )
}
