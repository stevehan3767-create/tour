import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { db, COL } from './firebase.js'
import {
  collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, limit, serverTimestamp, getDocs, getDoc,
} from 'firebase/firestore'
import {
  uploadToCloudinary, toDownloadUrl, toThumbUrl, isCloudinaryReady,
  VIDEO_MAX_BYTES, MAX_PHOTOS_PER_PERSON_PER_TRIP, humanSize,
} from './cloudinary.js'

/* ══════════════════════════════════════
   기본 정보 / 관리자 계정
══════════════════════════════════════ */
const CLUB_NAME = '백운호수 푸르지오 숲속의 아침 여행동호회'
const CLUB_INTRO = '경기도 의왕시 백운호수 푸르지오 숲속의 아침, 여행을 사랑하는 이웃들의 모임입니다.'
const ADMIN_ID = 'lyjlmh'
const ADMIN_PW = 'lyjlmh1234'
const ADMIN_SESSION_KEY = 'club_admin_session'

/* ══════════════════════════════════════
   색상 / 스타일
══════════════════════════════════════ */
const COLORS = {
  blue: '#1565C0',
  blueDark: '#0D47A1',
  blueLight: '#E3F2FD',
  green: '#2E7D32',
  greenBright: '#43A047',
  greenLight: '#E8F5E9',
  bg: '#F2F8F5',
  card: '#FFFFFF',
  text: '#1C2B22',
  sub: '#5B6B63',
  danger: '#D32F2F',
  dangerLight: '#FFEBEE',
  border: '#DCEBE2',
}

const S = {
  page: { maxWidth: 980, margin: '0 auto', padding: '28px 18px 80px' },
  card: { background: COLORS.card, borderRadius: 22, padding: 24, boxShadow: '0 4px 20px rgba(21,101,192,0.08)', border: `1px solid ${COLORS.border}` },
  h1: { fontSize: 'clamp(26px,4.5vw,38px)', fontWeight: 900, color: COLORS.blueDark, margin: '0 0 10px', lineHeight: 1.3 },
  h2: { fontSize: 'clamp(21px,3vw,27px)', fontWeight: 800, color: COLORS.blueDark, margin: '0 0 16px' },
  sub: { fontSize: 18, color: COLORS.sub, lineHeight: 1.7 },
  btn: (bg, big) => ({
    background: bg, color: '#fff', border: 'none', borderRadius: 16,
    padding: big ? '18px 30px' : '14px 22px', fontSize: big ? 20 : 17, fontWeight: 800,
    display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'center',
  }),
  btnOutline: { background: '#fff', color: COLORS.blueDark, border: `2px solid ${COLORS.blue}`, borderRadius: 16, padding: '13px 20px', fontSize: 17, fontWeight: 800 },
  btnGhost: { background: COLORS.greenLight, color: COLORS.green, border: 'none', borderRadius: 14, padding: '11px 18px', fontSize: 16, fontWeight: 700 },
  btnDanger: { background: COLORS.dangerLight, color: COLORS.danger, border: 'none', borderRadius: 12, padding: '9px 16px', fontSize: 15, fontWeight: 700 },
  input: { width: '100%', padding: '15px 16px', borderRadius: 14, border: `2px solid ${COLORS.border}`, fontSize: 18, background: '#fff' },
  label: { display: 'block', fontSize: 16, fontWeight: 700, color: COLORS.text, marginBottom: 8 },
  chip: (bg, fg) => ({ background: bg, color: fg, borderRadius: 999, padding: '5px 14px', fontSize: 14, fontWeight: 800, display: 'inline-block' }),
}

/* ══════════════════════════════════════
   날짜 유틸
══════════════════════════════════════ */
const pad = (n) => String(n).padStart(2, '0')
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const WEEKDAY_KR = ['일', '월', '화', '수', '목', '금', '토']

function fmtDateLong(iso) {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00')
  if (isNaN(d)) return iso
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY_KR[d.getDay()]})`
}

/** 해당 연/월의 "둘째 주 화요일" 날짜(YYYY-MM-DD)를 계산합니다. */
function secondTuesday(year, monthIndex) {
  const d = new Date(year, monthIndex, 1)
  const firstTue = 1 + ((2 - d.getDay() + 7) % 7)
  return toISO(new Date(year, monthIndex, firstTue + 7))
}

function suggestNextTripDate() {
  const now = new Date()
  const thisMonth = secondTuesday(now.getFullYear(), now.getMonth())
  if (thisMonth >= toISO(now)) return thisMonth
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  return secondTuesday(next.getFullYear(), next.getMonth())
}

/** Firestore Timestamp를 "9월 15일 오후 2:32" 형식으로 표시합니다. */
function fmtDateTime(ts) {
  if (!ts?.toDate) return '방금 전'
  const d = ts.toDate()
  const ampm = d.getHours() < 12 ? '오전' : '오후'
  let h = d.getHours() % 12
  if (h === 0) h = 12
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${ampm} ${h}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 사진/영상을 "누가 · 언제 올렸는지" 알아보기 쉽도록 묶어줍니다.
 * 같은 사람이 10분 이내에 연달아 올린 것들은 한 그룹으로 합칩니다.
 * (list는 최신순으로 정렬되어 있어야 합니다)
 */
function groupByUploader(list) {
  const GAP_MS = 10 * 60 * 1000
  const groups = []
  for (const m of list) {
    const t = m.createdAt?.toDate ? m.createdAt.toDate().getTime() : Date.now()
    const name = m.uploaderName || ''
    const last = groups[groups.length - 1]
    if (last && last.uploaderName === name && last.time - t <= GAP_MS) {
      last.items.push(m)
      last.time = t
    } else {
      groups.push({ uploaderName: name, time: t, headerTs: m.createdAt, items: [m] })
    }
  }
  return groups
}

/* ══════════════════════════════════════
   Firestore 헬퍼 & 훅
══════════════════════════════════════ */
const fsAdd = (path, data) => addDoc(collection(db, ...path), { ...data, createdAt: serverTimestamp() })
const fsSet = (path, id, data) => setDoc(doc(db, ...path, id), { ...data, updatedAt: serverTimestamp() }, { merge: true })
const fsUpdate = (path, id, data) => updateDoc(doc(db, ...path, id), { ...data, updatedAt: serverTimestamp() })
const fsDel = (path, id) => deleteDoc(doc(db, ...path, id))

function useCollection(path, orderField = 'createdAt', dir = 'desc', max) {
  const [data, setData] = useState([])
  const key = path.join('/')
  useEffect(() => {
    try {
      const clauses = [orderBy(orderField, dir)]
      if (max) clauses.push(limit(max))
      const q = query(collection(db, ...path), ...clauses)
      const unsub = onSnapshot(q, (snap) => {
        setData(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
      }, () => {})
      return unsub
    } catch {
      return () => {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, orderField, dir, max])
  return { data }
}

/** 컬렉션이 아닌 문서 하나(예: 관리자 설정)를 구독합니다. */
function useDoc(path, id) {
  const [data, setData] = useState(null)
  useEffect(() => {
    if (!id) return
    try {
      return onSnapshot(doc(db, ...path, id), (snap) => {
        setData(snap.exists() ? { id: snap.id, ...snap.data() } : null)
      }, () => {})
    } catch {
      return () => {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path.join('/'), id])
  return data
}

/** 공지사항·문의 내용 속의 인터넷 주소를 눌러서 바로 이동할 수 있는 링크로 바꿔줍니다. */
const URL_REGEX = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi
function Linkify({ text }) {
  if (!text) return null
  return text.split(URL_REGEX).map((part, i) => {
    if (/^(https?:\/\/|www\.)/i.test(part)) {
      const href = part.startsWith('http') ? part : `https://${part}`
      return <a key={i} href={href} target="_blank" rel="noopener noreferrer" style={{ color: COLORS.blue, textDecoration: 'underline', wordBreak: 'break-all' }}>{part}</a>
    }
    return part
  })
}

/**
 * 처음 방문했을 때 홈페이지가 비어 보이지 않도록, 실제 여행에서 찍은
 * 사진 몇 장으로 예시 여행앨범과 대표사진을 한 번만 자동으로 만들어 둡니다.
 * (이미 만들어져 있으면 다시 실행하지 않습니다)
 */
async function ensureSeedData() {
  try {
    const markerRef = doc(db, 'club_config', 'seeded')
    const markerSnap = await getDoc(markerRef)
    if (markerSnap.exists()) return

    const tripId = 'sample-trip-2026-06'
    const tripTitle = '6월 정기 여행 - 동해안 나들이'
    await setDoc(doc(db, COL.trips, tripId), { date: '2026-06-16', title: tripTitle, createdAt: serverTimestamp() })

    const photoDefs = [
      { id: 'p1', file: 'group-jetty.jpg', bytes: 75000, featured: true },
      { id: 'p2', file: 'group-heart-beach.jpg', bytes: 217701, featured: true },
      { id: 'p3', file: 'sea-view.jpg', bytes: 228707, featured: true },
      { id: 'p4', file: 'lake-view.jpg', bytes: 186215, featured: true },
      { id: 'p5', file: 'flower-field.jpg', bytes: 355739, featured: true },
      { id: 'p6', file: 'garden-path.jpg', bytes: 448201, featured: false },
      { id: 'p7', file: 'member-badge.jpg', bytes: 150661, featured: false },
      { id: 'p8', file: 'bus-exterior.jpg', bytes: 267561, featured: false },
      { id: 'p9', file: 'bus-interior.jpg', bytes: 263862, featured: false },
    ]
    for (const p of photoDefs) {
      const url = `/images/sample/${p.file}`
      await setDoc(doc(db, COL.trips, tripId, COL.media, p.id), {
        type: 'photo', url, format: 'jpg', bytes: p.bytes,
        originalName: p.file, uploaderName: 'Steve Han',
        featured: p.featured, createdAt: serverTimestamp(),
      })
      if (p.featured) {
        await setDoc(doc(db, COL.featured, p.id), { url, tripId, tripTitle, addedAt: serverTimestamp() })
      }
    }
    await setDoc(doc(db, COL.trips, tripId, COL.media, 'f1'), {
      type: 'file', url: '/images/sample/itinerary.png', format: 'png', bytes: 414408,
      originalName: '여행_일정표_예시.png', uploaderName: '관리자', featured: false, createdAt: serverTimestamp(),
    })
    await addDoc(collection(db, COL.notices), {
      title: `${CLUB_NAME}에 오신 것을 환영합니다!`,
      content: '홈페이지가 새로 열렸습니다. 매월 둘째 주 화요일 여행에서 찍은 사진과 영상을 자유롭게 올리고, 보고, 다운로드해 보세요.',
      createdAt: serverTimestamp(),
    })
    await setDoc(doc(db, COL.config, 'notify'), { phone: '01047543767', createdAt: serverTimestamp() })
    await setDoc(markerRef, { seededAt: serverTimestamp() })
  } catch (e) {
    console.warn('샘플 데이터 생성 실패:', e)
  }
}

/* ══════════════════════════════════════
   공통 UI 조각
══════════════════════════════════════ */
function Toast({ toast }) {
  if (!toast) return null
  return (
    <div style={{
      position: 'fixed', bottom: 26, left: '50%', transform: 'translateX(-50%)',
      background: toast.type === 'error' ? COLORS.danger : COLORS.green, color: '#fff',
      padding: '16px 26px', borderRadius: 16, boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
      zIndex: 9999, fontWeight: 700, fontSize: 17, maxWidth: '90vw', textAlign: 'center',
    }}>
      {toast.msg}
    </div>
  )
}

function ConfigWarning() {
  if (isCloudinaryReady()) return null
  return (
    <div style={{ background: '#FFF8E1', border: '2px solid #FFD54F', borderRadius: 16, padding: '16px 20px', margin: '0 0 20px', fontSize: 16, color: '#7a5c00' }}>
      ⚠️ 사진·영상 저장소(Cloudinary)가 아직 설정되지 않았습니다. <b>.env</b> 파일에
      <code style={{ margin: '0 4px' }}>VITE_CLOUDINARY_CLOUD_NAME</code>과
      <code style={{ margin: '0 4px' }}>VITE_CLOUDINARY_UPLOAD_PRESET</code>을 설정한 뒤 다시 실행해 주세요. (README 참고)
    </div>
  )
}

/* ══════════════════════════════════════
   헤더 / 내비게이션
══════════════════════════════════════ */
function Header({ page, go, isAdmin, onAdminLogin, onAdminLogout }) {
  const items = [
    ['home', '🏠 홈'],
    ['notices', '📢 공지사항'],
    ['trips', '📷 여행앨범'],
    ['inquiry', '✉️ 문의하기'],
  ]
  return (
    <header style={{ background: `linear-gradient(120deg, ${COLORS.blueDark}, ${COLORS.blue})`, color: '#fff', position: 'sticky', top: 0, zIndex: 100, boxShadow: '0 4px 18px rgba(0,0,0,0.18)' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div onClick={() => go('home')} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <div style={{ fontSize: 30 }}>🚌</div>
          <div style={{ fontWeight: 900, fontSize: 18, lineHeight: 1.25 }}>백운호수 푸르지오<br />숲속의 아침 여행동호회</div>
        </div>
        <nav style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {items.map(([k, label]) => (
            <button key={k} onClick={() => go(k)} style={{
              background: page === k ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.14)',
              color: page === k ? COLORS.blueDark : '#fff', border: 'none', borderRadius: 14,
              padding: '11px 16px', fontSize: 16, fontWeight: 800,
            }}>{label}</button>
          ))}
          {isAdmin ? (
            <>
              <button onClick={() => go('admin')} style={{ background: COLORS.greenBright, color: '#fff', border: 'none', borderRadius: 14, padding: '11px 16px', fontSize: 16, fontWeight: 800 }}>⚙️ 관리자</button>
              <button onClick={onAdminLogout} style={{ background: 'rgba(255,255,255,0.14)', color: '#fff', border: 'none', borderRadius: 14, padding: '11px 14px', fontSize: 15, fontWeight: 700 }}>로그아웃</button>
            </>
          ) : (
            <button onClick={onAdminLogin} style={{ background: 'rgba(255,255,255,0.14)', color: '#fff', border: 'none', borderRadius: 14, padding: '11px 16px', fontSize: 15, fontWeight: 700 }}>🔑 관리자</button>
          )}
        </nav>
      </div>
    </header>
  )
}

/* ══════════════════════════════════════
   관리자 로그인 모달
══════════════════════════════════════ */
function AdminLoginModal({ onClose, onSuccess, showToast }) {
  const [id, setId] = useState('')
  const [pw, setPw] = useState('')
  const submit = () => {
    if (id.trim() === ADMIN_ID && pw === ADMIN_PW) {
      onSuccess()
    } else {
      showToast('아이디 또는 비밀번호가 올바르지 않습니다.', 'error')
    }
  }
  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={{ position: 'fixed', inset: 0, background: 'rgba(10,30,20,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 24, padding: 34, width: 'min(400px,92vw)', boxShadow: '0 24px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🔑</div>
          <h2 style={{ ...S.h2, margin: 0 }}>관리자 로그인</h2>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={S.label}>아이디</label>
            <input style={S.input} value={id} onChange={(e) => setId(e.target.value)} autoFocus />
          </div>
          <div>
            <label style={S.label}>비밀번호</label>
            <input style={S.input} type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </div>
          <button onClick={submit} style={{ ...S.btn(COLORS.blue, true), width: '100%', marginTop: 6 }}>로그인</button>
          <button onClick={onClose} style={{ ...S.btnOutline, width: '100%' }}>취소</button>
        </div>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════
   홈 페이지 (대표사진 슬라이드 2초 간격)
══════════════════════════════════════ */
function HeroSlider({ featured }) {
  const [idx, setIdx] = useState(0)
  useEffect(() => {
    if (featured.length < 2) return
    const t = setInterval(() => setIdx((i) => (i + 1) % featured.length), 2000)
    return () => clearInterval(t)
  }, [featured.length])

  if (featured.length === 0) {
    return (
      <div style={{ height: 'min(460px,58vw)', minHeight: 260, background: `linear-gradient(135deg, ${COLORS.blue}, ${COLORS.green})`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', textAlign: 'center', padding: 20 }}>
        <div>
          <div style={{ fontSize: 46, marginBottom: 10 }}>🏞️🚌</div>
          <div style={{ fontSize: 'clamp(22px,4vw,34px)', fontWeight: 900 }}>{CLUB_NAME}</div>
          <div style={{ fontSize: 16, opacity: 0.9, marginTop: 8 }}>관리자가 대표사진을 등록하면 이곳에 표시됩니다.</div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', height: 'min(460px,58vw)', minHeight: 260, overflow: 'hidden' }}>
      {featured.map((f, i) => (
        <img key={f.id} src={toThumbUrl(f.url, 1200)} alt="여행 대표사진"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: i === idx ? 1 : 0, transition: 'opacity 1s ease' }} />
      ))}
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, rgba(0,0,0,0.05), rgba(0,0,0,0.55))' }} />
      <div style={{ position: 'relative', zIndex: 2, height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#fff', textAlign: 'center', padding: '0 20px' }}>
        <div style={{ fontSize: 'clamp(24px,4.5vw,40px)', fontWeight: 900, textShadow: '0 3px 16px rgba(0,0,0,0.6)' }}>{CLUB_NAME}</div>
        <div style={{ fontSize: 'clamp(15px,2.4vw,19px)', marginTop: 10, fontWeight: 600, textShadow: '0 2px 10px rgba(0,0,0,0.5)' }}>{featured[idx]?.tripTitle || ''}</div>
      </div>
      <div style={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 8, zIndex: 3 }}>
        {featured.map((_, i) => (
          <div key={i} style={{ width: i === idx ? 22 : 9, height: 9, borderRadius: 5, background: i === idx ? COLORS.greenBright : 'rgba(255,255,255,0.6)', transition: 'all 0.3s' }} />
        ))}
      </div>
    </div>
  )
}

function HomePage({ go, notices, trips, featured }) {
  return (
    <div>
      <HeroSlider featured={featured} />
      <div style={S.page}>
        <div style={{ ...S.card, textAlign: 'center', marginBottom: 26, background: COLORS.greenLight, border: 'none' }}>
          <p style={{ fontSize: 20, fontWeight: 700, color: COLORS.green, margin: 0 }}>{CLUB_INTRO}</p>
          <p style={{ fontSize: 17, color: COLORS.text, marginTop: 8 }}>매월 둘째 주 화요일, 함께 떠나는 여행 🚌</p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 16, marginBottom: 30 }}>
          <button onClick={() => go('trips')} style={{ ...S.btn(`linear-gradient(135deg, ${COLORS.blue}, ${COLORS.blueDark})`, true) }}>📷 여행앨범 보러가기</button>
          <button onClick={() => go('inquiry')} style={{ ...S.btn(`linear-gradient(135deg, ${COLORS.greenBright}, ${COLORS.green})`, true) }}>✉️ 문의하기</button>
        </div>

        <section style={{ marginBottom: 30 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <h2 style={S.h2}>📢 공지사항</h2>
            <button onClick={() => go('notices')} style={{ background: 'none', border: 'none', color: COLORS.blue, fontSize: 16, fontWeight: 700 }}>전체보기 →</button>
          </div>
          {notices.length === 0 ? (
            <div style={{ ...S.card, textAlign: 'center', color: COLORS.sub }}>등록된 공지사항이 없습니다.</div>
          ) : notices.slice(0, 3).map((n) => (
            <div key={n.id} style={{ ...S.card, marginBottom: 12, borderLeft: `6px solid ${COLORS.blue}` }}>
              <div style={{ fontWeight: 800, fontSize: 19 }}>{n.title}</div>
              <div style={{ color: COLORS.sub, fontSize: 16, marginTop: 6, whiteSpace: 'pre-wrap' }}>{(n.content || '').slice(0, 60)}{(n.content || '').length > 60 ? '…' : ''}</div>
            </div>
          ))}
        </section>

        <section>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <h2 style={S.h2}>🗓️ 최근 여행</h2>
            <button onClick={() => go('trips')} style={{ background: 'none', border: 'none', color: COLORS.blue, fontSize: 16, fontWeight: 700 }}>전체보기 →</button>
          </div>
          {trips.length === 0 ? (
            <div style={{ ...S.card, textAlign: 'center', color: COLORS.sub }}>등록된 여행이 없습니다.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 16 }}>
              {trips.slice(0, 3).map((t) => (
                <div key={t.id} onClick={() => go('tripDetail', t.id)} style={{ ...S.card, cursor: 'pointer', padding: 20 }}>
                  <div style={S.chip(COLORS.blueLight, COLORS.blueDark)}>{fmtDateLong(t.date)}</div>
                  <div style={{ fontWeight: 800, fontSize: 19, marginTop: 10 }}>{t.title}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════
   공지사항 페이지
══════════════════════════════════════ */
function NoticesPage({ notices, isAdmin, showToast }) {
  const [openId, setOpenId] = useState(null)
  const [form, setForm] = useState({ title: '', content: '' })
  const [editing, setEditing] = useState(null)

  const submit = async () => {
    if (!form.title.trim() || !form.content.trim()) { showToast('제목과 내용을 입력해주세요.', 'error'); return }
    await fsAdd([COL.notices], form)
    setForm({ title: '', content: '' })
    showToast('공지사항이 등록되었습니다.')
  }
  const saveEdit = async (id) => {
    await fsUpdate([COL.notices], id, { title: editing.title, content: editing.content })
    setEditing(null)
    showToast('수정되었습니다.')
  }
  const remove = async (id) => {
    if (!confirm('이 공지사항을 삭제할까요?')) return
    await fsDel([COL.notices], id)
    showToast('삭제되었습니다.')
  }

  return (
    <div style={S.page}>
      <h1 style={S.h1}>📢 공지사항</h1>
      {isAdmin && (
        <div style={{ ...S.card, marginBottom: 22, background: COLORS.blueLight, border: 'none' }}>
          <div style={S.label}>새 공지 등록</div>
          <input style={{ ...S.input, marginBottom: 10 }} placeholder="제목" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <textarea style={{ ...S.input, minHeight: 100, resize: 'vertical', marginBottom: 10 }} placeholder="내용" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
          <button onClick={submit} style={S.btn(COLORS.blue)}>등록하기</button>
        </div>
      )}
      {notices.length === 0 && <div style={{ ...S.card, textAlign: 'center', color: COLORS.sub }}>등록된 공지사항이 없습니다.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {notices.map((n) => (
          <div key={n.id} style={S.card}>
            {editing?.id === n.id ? (
              <>
                <input style={{ ...S.input, marginBottom: 10 }} value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
                <textarea style={{ ...S.input, minHeight: 100, marginBottom: 10 }} value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => saveEdit(n.id)} style={S.btnGhost}>저장</button>
                  <button onClick={() => setEditing(null)} style={S.btnDanger}>취소</button>
                </div>
              </>
            ) : (
              <>
                <div onClick={() => setOpenId(openId === n.id ? null : n.id)} style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontWeight: 800, fontSize: 20 }}>{n.title}</div>
                  <div style={{ fontSize: 20, color: COLORS.blue }}>{openId === n.id ? '▲' : '▼'}</div>
                </div>
                {openId === n.id && <div style={{ marginTop: 12, fontSize: 17, color: COLORS.text, whiteSpace: 'pre-wrap', lineHeight: 1.8 }}><Linkify text={n.content} /></div>}
                {isAdmin && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button onClick={() => setEditing({ id: n.id, title: n.title, content: n.content })} style={S.btnGhost}>수정</button>
                    <button onClick={() => remove(n.id)} style={S.btnDanger}>삭제</button>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ══════════════════════════════════════
   여행앨범 목록
══════════════════════════════════════ */
function TripsPage({ trips, go, isAdmin, showToast }) {
  const [form, setForm] = useState({ date: suggestNextTripDate(), title: '' })

  const create = async () => {
    if (!form.date) { showToast('여행 날짜를 선택해주세요.', 'error'); return }
    const d = new Date(form.date + 'T00:00:00')
    const title = form.title.trim() || `${d.getMonth() + 1}월 정기 여행`
    await fsAdd([COL.trips], { date: form.date, title })
    setForm({ date: suggestNextTripDate(), title: '' })
    showToast('여행이 등록되었습니다.')
  }
  const remove = async (t) => {
    if (!confirm(`"${t.title}" 여행과 그 안의 모든 사진·영상 기록을 삭제할까요?`)) return
    const mediaSnap = await getDocs(collection(db, COL.trips, t.id, COL.media))
    await Promise.all(mediaSnap.docs.map((m) => deleteDoc(doc(db, COL.trips, t.id, COL.media, m.id))))
    await fsDel([COL.trips], t.id)
    showToast('삭제되었습니다.')
  }

  return (
    <div style={S.page}>
      <h1 style={S.h1}>📷 여행앨범</h1>
      <p style={S.sub}>여행 날짜를 눌러 사진·영상·자료를 보고, 올릴 수 있어요.</p>

      {isAdmin && (
        <div style={{ ...S.card, margin: '18px 0 22px', background: COLORS.blueLight, border: 'none' }}>
          <div style={S.label}>새 여행 등록</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <input style={S.input} type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            <input style={S.input} placeholder="여행 제목 (예: 10월 정기 여행)" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <button onClick={create} style={S.btn(COLORS.blue)}>여행 등록</button>
        </div>
      )}

      {trips.length === 0 && <div style={{ ...S.card, textAlign: 'center', color: COLORS.sub }}>등록된 여행이 없습니다.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 16 }}>
        {trips.map((t) => (
          <div key={t.id} style={{ ...S.card, padding: 20, position: 'relative' }}>
            <div onClick={() => go('tripDetail', t.id)} style={{ cursor: 'pointer' }}>
              <div style={S.chip(COLORS.blueLight, COLORS.blueDark)}>{fmtDateLong(t.date)}</div>
              <div style={{ fontWeight: 800, fontSize: 20, marginTop: 10 }}>{t.title}</div>
              <div style={{ marginTop: 10, color: COLORS.blue, fontWeight: 700 }}>사진·영상 보러가기 →</div>
            </div>
            {isAdmin && (
              <button onClick={() => remove(t)} style={{ ...S.btnDanger, position: 'absolute', top: 14, right: 14 }}>삭제</button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ══════════════════════════════════════
   라이트박스 (사진 크게 보기)
══════════════════════════════════════ */
function Lightbox({ photos, index, onClose, onIndex, onDelete }) {
  const cur = photos[index]
  if (!cur) return null
  const move = (d) => onIndex((index + d + photos.length) % photos.length)
  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', zIndex: 2000, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <img src={cur.url} alt="여행 사진" style={{ maxWidth: '92vw', maxHeight: '76vh', objectFit: 'contain', borderRadius: 10 }} />
      <div style={{ display: 'flex', gap: 14, marginTop: 18, flexWrap: 'wrap', justifyContent: 'center' }}>
        {photos.length > 1 && <button onClick={() => move(-1)} style={S.btnOutline}>◀ 이전</button>}
        <a href={toDownloadUrl(cur.url, cur.originalName)} style={{ ...S.btn(COLORS.greenBright), textDecoration: 'none' }}>⬇ 다운로드</a>
        <button onClick={async () => { if (await onDelete(cur)) onClose() }} style={S.btnDanger}>🗑️ 삭제</button>
        <button onClick={onClose} style={S.btnOutline}>닫기</button>
        {photos.length > 1 && <button onClick={() => move(1)} style={S.btnOutline}>다음 ▶</button>}
      </div>
      {cur.uploaderName && <div style={{ color: '#fff', marginTop: 12, fontSize: 15, opacity: 0.85 }}>올린 사람: {cur.uploaderName}</div>}
    </div>
  )
}

/* ══════════════════════════════════════
   여행 상세 (사진/영상/자료 업로드,보기,다운로드)
══════════════════════════════════════ */
const FILE_ICON = { pdf: '📕', doc: '📄', docx: '📄', hwp: '📄', hwpx: '📄', xls: '📊', xlsx: '📊', ppt: '📽️', pptx: '📽️', zip: '🗜️' }

function TripDetailPage({ tripId, trips, go, isAdmin, showToast }) {
  const trip = trips.find((t) => t.id === tripId)
  const { data: media } = useCollection([COL.trips, tripId, COL.media], 'createdAt', 'desc')
  const [uploaderName, setUploaderName] = useState(() => localStorage.getItem('club_uploader_name') || '')
  const [uploading, setUploading] = useState(null)
  const [pending, setPending] = useState(null)
  const [lightbox, setLightbox] = useState(null)
  const [tab, setTab] = useState('photo')
  const photoInputRef = useRef(null)
  const videoInputRef = useRef(null)
  const fileInputRef = useRef(null)

  useEffect(() => { localStorage.setItem('club_uploader_name', uploaderName) }, [uploaderName])

  const photos = useMemo(() => media.filter((m) => m.type === 'photo'), [media])
  const videos = useMemo(() => media.filter((m) => m.type === 'video'), [media])
  const files = useMemo(() => media.filter((m) => m.type === 'file'), [media])
  const featuredIds = useMemo(() => new Set(media.filter((m) => m.featured).map((m) => m.id)), [media])

  const doUpload = async (file, type, name) => {
    setUploading({ name: file.name, percent: 0 })
    try {
      const res = await uploadToCloudinary(file, (p) => setUploading({ name: file.name, percent: p }))
      await addDoc(collection(db, COL.trips, tripId, COL.media), {
        type, url: res.secure_url, publicId: res.public_id, format: res.format,
        bytes: res.bytes, originalName: file.name, uploaderName: name,
        featured: false, createdAt: serverTimestamp(),
      })
    } catch (e) {
      showToast(e.message === 'CLOUDINARY_NOT_CONFIGURED' ? '사진/영상 저장소 설정이 필요합니다. (README 참고)' : `업로드 실패: ${e.message}`, 'error')
    } finally {
      setUploading(null)
    }
  }

  /** 사진/영상/자료를 실제로 업로드합니다. (이름이 준비된 뒤에만 호출) */
  const runUploadBatch = async (kind, list, name) => {
    if (kind === 'photo') {
      const already = photos.filter((p) => p.uploaderName?.trim() === name).length
      const remaining = MAX_PHOTOS_PER_PERSON_PER_TRIP - already
      if (remaining <= 0) { showToast(`${name}님은 이번 여행에 이미 ${already}장을 올리셨어요. (1인당 최대 ${MAX_PHOTOS_PER_PERSON_PER_TRIP}장)`, 'error'); return }
      const toUpload = list.slice(0, remaining)
      if (list.length > remaining) showToast(`최대 ${MAX_PHOTOS_PER_PERSON_PER_TRIP}장까지만 올릴 수 있어 ${toUpload.length}장만 업로드합니다.`)
      for (const f of toUpload) await doUpload(f, 'photo', name)
      showToast('사진 업로드 완료!')
    } else if (kind === 'video') {
      const f = list[0]
      if (f.size > VIDEO_MAX_BYTES) { showToast(`영상 용량(${humanSize(f.size)})이 100MB를 넘어 업로드할 수 없어요.`, 'error'); return }
      await doUpload(f, 'video', name)
      showToast('영상 업로드 완료!')
    } else if (kind === 'file') {
      await doUpload(list[0], 'file', name)
      showToast('자료 업로드 완료!')
    }
  }

  /** 파일을 고르면: 이름이 이미 있으면 바로 업로드, 없으면 이름을 넣을 때까지 대기시킵니다. (선택 순서 상관없음) */
  const handlePicked = (kind, list) => {
    if (list.length === 0) return
    const name = uploaderName.trim()
    if (!name) {
      setPending({ kind, list })
      showToast('이름을 입력하고 "업로드하기"를 눌러주세요.')
      return
    }
    runUploadBatch(kind, list, name)
  }

  const onPickPhotos = (e) => {
    const list = Array.from(e.target.files || []); e.target.value = ''
    handlePicked('photo', list)
  }
  const onPickVideo = (e) => {
    const f = e.target.files?.[0]; e.target.value = ''
    handlePicked('video', f ? [f] : [])
  }
  const onPickFile = (e) => {
    const f = e.target.files?.[0]; e.target.value = ''
    handlePicked('file', f ? [f] : [])
  }

  const confirmPendingUpload = () => {
    const name = uploaderName.trim()
    if (!name) { showToast('먼저 이름을 입력해주세요.', 'error'); return }
    if (!pending) return
    runUploadBatch(pending.kind, pending.list, name)
    setPending(null)
  }

  /** 관리자이거나, 지금 입력된 이름이 그 사진/영상/자료를 올린 사람과 같으면 삭제할 수 있습니다. */
  const canDelete = (m) => {
    if (isAdmin) return true
    const name = uploaderName.trim().toLowerCase()
    return Boolean(name) && (m.uploaderName || '').trim().toLowerCase() === name
  }

  /** 삭제 버튼은 누구에게나 보이지만, 실제 삭제는 올린 사람 본인 또는 관리자만 할 수 있습니다. */
  const removeMedia = async (m) => {
    if (!canDelete(m)) {
      showToast('본인이 올린 사진·영상·자료만 삭제할 수 있어요. (관리자만 다른 사람 것도 삭제할 수 있습니다)', 'error')
      return false
    }
    if (!confirm('삭제할까요?')) return false
    await deleteDoc(doc(db, COL.trips, tripId, COL.media, m.id))
    if (m.featured) await fsDel([COL.featured], m.id).catch(() => {})
    showToast('삭제되었습니다.')
    return true
  }

  const toggleFeatured = async (m) => {
    if (!m.featured) {
      if (featuredIds.size >= 5) { showToast('대표사진은 최대 5장까지 선택할 수 있어요. 다른 사진을 먼저 해제해주세요.', 'error'); return }
      await updateDoc(doc(db, COL.trips, tripId, COL.media, m.id), { featured: true })
      await fsSet([COL.featured], m.id, { url: m.url, tripId, tripTitle: trip?.title || '', addedAt: serverTimestamp() })
      showToast('대표사진으로 등록했습니다.')
    } else {
      await updateDoc(doc(db, COL.trips, tripId, COL.media, m.id), { featured: false })
      await fsDel([COL.featured], m.id)
      showToast('대표사진에서 제외했습니다.')
    }
  }

  if (!trip) {
    return (
      <div style={S.page}>
        <div style={{ ...S.card, textAlign: 'center' }}>
          <p style={S.sub}>여행 정보를 불러오는 중이거나 존재하지 않습니다.</p>
          <button onClick={() => go('trips')} style={{ ...S.btn(COLORS.blue), marginTop: 14 }}>여행앨범으로</button>
        </div>
      </div>
    )
  }

  return (
    <div style={S.page}>
      <button onClick={() => go('trips')} style={{ background: 'none', border: 'none', color: COLORS.blue, fontSize: 16, fontWeight: 700, marginBottom: 10 }}>← 여행앨범 목록</button>
      <div style={S.chip(COLORS.blueLight, COLORS.blueDark)}>{fmtDateLong(trip.date)}</div>
      <h1 style={{ ...S.h1, marginTop: 10 }}>{trip.title}</h1>

      <div style={{ ...S.card, background: COLORS.greenLight, border: 'none', marginBottom: 22 }}>
        <div style={S.label}>이름</div>
        <input style={{ ...S.input, maxWidth: 320 }} placeholder="예: 홍길동" value={uploaderName} onChange={(e) => setUploaderName(e.target.value)} />
        <input ref={photoInputRef} type="file" accept="image/*" multiple hidden onChange={onPickPhotos} />
        <input ref={videoInputRef} type="file" accept="video/*" hidden onChange={onPickVideo} />
        <input ref={fileInputRef} type="file" hidden onChange={onPickFile} />
        {pending && (
          <div style={{ marginTop: 14, background: '#fff', border: `2px dashed ${COLORS.blue}`, borderRadius: 14, padding: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              {pending.kind === 'photo' && `📷 사진 ${pending.list.length}장 선택됨`}
              {pending.kind === 'video' && `🎬 영상 선택됨 (${pending.list[0].name})`}
              {pending.kind === 'file' && `📎 자료 선택됨 (${pending.list[0].name})`}
            </div>
            <div style={{ fontSize: 14, color: COLORS.sub, marginBottom: 10 }}>위에 이름을 입력한 뒤 아래 버튼을 눌러 업로드하세요.</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={confirmPendingUpload} style={S.btn(COLORS.blue)}>업로드하기</button>
              <button onClick={() => setPending(null)} style={S.btnDanger}>선택 취소</button>
            </div>
          </div>
        )}
        {uploading && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 14, marginBottom: 6 }}>업로드 중… {uploading.name} ({uploading.percent}%)</div>
            <div style={{ height: 10, background: '#fff', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${uploading.percent}%`, background: COLORS.greenBright, transition: 'width 0.2s' }} />
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {[
          ['photo', '📷 사진보기', photos.length],
          ['video', '🎬 동영상보기', videos.length],
          ['file', '📎 자료보기', files.length],
        ].map(([k, label, count]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            background: tab === k ? COLORS.blue : '#fff', color: tab === k ? '#fff' : COLORS.blueDark,
            border: `2px solid ${COLORS.blue}`, borderRadius: 14, padding: '13px 20px', fontSize: 17, fontWeight: 800,
          }}>{label} ({count})</button>
        ))}
      </div>

      {tab === 'photo' && (
        <section style={{ marginBottom: 30 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
            <h2 style={{ ...S.h2, margin: 0 }}>📷 사진 ({photos.length})</h2>
            <button onClick={() => photoInputRef.current?.click()} style={S.btn(COLORS.blue)}>📷 사진 올리기</button>
          </div>
          <div style={{ fontSize: 14, color: COLORS.sub, marginBottom: 16 }}>1인당 최대 {MAX_PHOTOS_PER_PERSON_PER_TRIP}장, 원본 화질 그대로 저장됩니다.</div>
          {photos.length === 0 ? <div style={{ color: COLORS.sub }}>아직 사진이 없습니다.</div> : (
            groupByUploader(photos).map((g, gi) => (
              <div key={gi} style={{ marginBottom: 22 }}>
                <div style={{ fontWeight: 700, color: COLORS.sub, marginBottom: 10, fontSize: 15 }}>🙍 {g.uploaderName || '이름없음'} · {fmtDateTime(g.headerTs)} · {g.items.length}장</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 10 }}>
                  {g.items.map((p) => {
                    const i = photos.indexOf(p)
                    return (
                      <div key={p.id} style={{ position: 'relative', borderRadius: 14, overflow: 'hidden', aspectRatio: '1/1', cursor: 'pointer', border: p.featured ? `4px solid ${COLORS.greenBright}` : 'none' }}>
                        <img onClick={() => setLightbox(i)} src={toThumbUrl(p.url, 400)} alt="여행사진" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        <div style={{ position: 'absolute', top: 4, right: 4, display: 'flex', gap: 4 }}>
                          {isAdmin && <button onClick={() => toggleFeatured(p)} title="대표사진 지정" style={{ background: p.featured ? COLORS.greenBright : 'rgba(255,255,255,0.9)', border: 'none', borderRadius: 8, width: 32, height: 32, fontSize: 16 }}>★</button>}
                          <button onClick={() => removeMedia(p)} title="삭제" style={{ background: 'rgba(255,255,255,0.9)', border: 'none', borderRadius: 8, width: 32, height: 32, fontSize: 16 }}>🗑️</button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))
          )}
          {lightbox !== null && <Lightbox photos={photos} index={lightbox} onClose={() => setLightbox(null)} onIndex={setLightbox} onDelete={removeMedia} />}
        </section>
      )}

      {tab === 'video' && (
        <section style={{ marginBottom: 30 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
            <h2 style={{ ...S.h2, margin: 0 }}>🎬 동영상 ({videos.length})</h2>
            <button onClick={() => videoInputRef.current?.click()} style={S.btn(COLORS.greenBright)}>🎬 동영상 올리기</button>
          </div>
          <div style={{ fontSize: 14, color: COLORS.sub, marginBottom: 16 }}>1개당 최대 100MB까지 업로드할 수 있어요.</div>
          {videos.length === 0 ? <div style={{ color: COLORS.sub }}>아직 동영상이 없습니다.</div> : (
            groupByUploader(videos).map((g, gi) => (
              <div key={gi} style={{ marginBottom: 22 }}>
                <div style={{ fontWeight: 700, color: COLORS.sub, marginBottom: 10, fontSize: 15 }}>🙍 {g.uploaderName || '이름없음'} · {fmtDateTime(g.headerTs)} · {g.items.length}개</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 16 }}>
                  {g.items.map((v) => (
                    <div key={v.id} style={S.card}>
                      <video src={v.url} controls preload="metadata" style={{ width: '100%', borderRadius: 12, background: '#000' }} />
                      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginTop: 10, flexWrap: 'wrap', gap: 8 }}>
                        <a href={toDownloadUrl(v.url, v.originalName)} style={{ ...S.btnGhost, textDecoration: 'none' }}>⬇ 다운로드</a>
                        <button onClick={() => removeMedia(v)} style={S.btnDanger}>🗑️ 삭제</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </section>
      )}

      {tab === 'file' && (
        <section>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
            <h2 style={{ ...S.h2, margin: 0 }}>📎 자료 ({files.length})</h2>
            <button onClick={() => fileInputRef.current?.click()} style={S.btnOutline}>📎 자료 올리기</button>
          </div>
          {files.length === 0 ? <div style={{ color: COLORS.sub }}>아직 등록된 자료가 없습니다.</div> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {files.map((f) => (
                <div key={f.id} style={{ ...S.card, padding: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 26 }}>{FILE_ICON[f.format] || '📁'}</span>
                    <div>
                      <div style={{ fontWeight: 700 }}>{f.originalName}</div>
                      <div style={{ fontSize: 13, color: COLORS.sub }}>{f.uploaderName} · {fmtDateTime(f.createdAt)} · {humanSize(f.bytes)}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <a href={toDownloadUrl(f.url, f.originalName)} style={{ ...S.btnGhost, textDecoration: 'none' }}>⬇ 다운로드</a>
                    <button onClick={() => removeMedia(f)} style={S.btnDanger}>🗑️ 삭제</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

/* ══════════════════════════════════════
   문의하기
══════════════════════════════════════ */
function InquiryPage({ isAdmin, showToast }) {
  const { data: inquiries } = useCollection([COL.inquiries], 'createdAt', 'desc')
  const [form, setForm] = useState({ name: '', contact: '', message: '' })
  const [replyDraft, setReplyDraft] = useState({})
  const notifyConfig = useDoc([COL.config], 'notify')

  const submit = async () => {
    if (!form.name.trim() || !form.contact.trim() || !form.message.trim()) { showToast('이름, 연락처, 내용을 모두 입력해주세요.', 'error'); return }
    const { name, contact, message } = form
    await fsAdd([COL.inquiries], { name, contact, message, answered: false, answer: '' })
    setForm({ name: '', contact: '', message: '' })
    showToast('문의가 접수되었습니다. 확인 후 연락드릴게요!')
    if (notifyConfig?.phone) {
      fetch('/api/notify-inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, contact, message, to: notifyConfig.phone }),
      }).catch(() => {})
    }
  }

  const reply = async (id) => {
    const text = replyDraft[id] ?? ''
    await fsUpdate([COL.inquiries], id, { answer: text, answered: true })
    showToast('답변이 저장되었습니다.')
  }

  return (
    <div style={S.page}>
      <h1 style={S.h1}>✉️ 문의하기</h1>
      <p style={S.sub}>궁금한 점이나 하고 싶은 말씀을 남겨주세요. 회원가입 없이 바로 남기실 수 있어요.</p>

      <div style={{ ...S.card, margin: '18px 0 30px' }}>
        <div style={S.label}>이름</div>
        <input style={{ ...S.input, marginBottom: 12 }} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <div style={S.label}>연락처 (전화번호 등)</div>
        <input style={{ ...S.input, marginBottom: 12 }} value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} />
        <div style={S.label}>내용</div>
        <textarea style={{ ...S.input, minHeight: 120, marginBottom: 14 }} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
        <button onClick={submit} style={{ ...S.btn(COLORS.blue, true), width: '100%' }}>문의 보내기</button>
      </div>

      {isAdmin && (
        <section>
          <h2 style={S.h2}>📬 접수된 문의 ({inquiries.length})</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {inquiries.map((q) => (
              <div key={q.id} style={S.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                  <div style={{ fontWeight: 800 }}>{q.name} ({q.contact})</div>
                  <span style={S.chip(q.answered ? COLORS.greenLight : COLORS.dangerLight, q.answered ? COLORS.green : COLORS.danger)}>{q.answered ? '답변완료' : '미답변'}</span>
                </div>
                <div style={{ marginTop: 8, color: COLORS.text, whiteSpace: 'pre-wrap' }}><Linkify text={q.message} /></div>
                <textarea style={{ ...S.input, minHeight: 70, marginTop: 12 }} placeholder="답변 입력" defaultValue={q.answer || ''} onChange={(e) => setReplyDraft((d) => ({ ...d, [q.id]: e.target.value }))} />
                <button onClick={() => reply(q.id)} style={{ ...S.btnGhost, marginTop: 8 }}>답변 저장</button>
              </div>
            ))}
            {inquiries.length === 0 && <div style={{ color: COLORS.sub }}>접수된 문의가 없습니다.</div>}
          </div>
        </section>
      )}
    </div>
  )
}

/* ══════════════════════════════════════
   관리자 - 대표사진 선택
══════════════════════════════════════ */
function AdminFeaturedTab({ trips, showToast }) {
  const [pool, setPool] = useState([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const all = []
    for (const t of trips.slice(0, 12)) {
      const snap = await getDocs(collection(db, COL.trips, t.id, COL.media))
      snap.docs.forEach((d) => {
        const data = d.data()
        if (data.type === 'photo') all.push({ id: d.id, tripId: t.id, tripTitle: t.title, tripDate: t.date, ...data })
      })
    }
    setPool(all)
    setLoading(false)
  }, [trips])

  useEffect(() => { load() }, [load])

  const featuredCount = pool.filter((p) => p.featured).length

  /** 어느 여행 사진인지 한눈에 보이도록 여행별로 묶습니다. */
  const groups = useMemo(() => {
    const list = []
    for (const p of pool) {
      const last = list[list.length - 1]
      if (last && last.tripId === p.tripId) last.items.push(p)
      else list.push({ tripId: p.tripId, tripTitle: p.tripTitle, tripDate: p.tripDate, items: [p] })
    }
    return list
  }, [pool])

  const toggle = async (p) => {
    if (!p.featured && featuredCount >= 5) { showToast('대표사진은 최대 5장까지 선택할 수 있어요.', 'error'); return }
    await updateDoc(doc(db, COL.trips, p.tripId, COL.media, p.id), { featured: !p.featured })
    if (!p.featured) {
      await fsSet([COL.featured], p.id, { url: p.url, tripId: p.tripId, tripTitle: p.tripTitle, addedAt: serverTimestamp() })
    } else {
      await fsDel([COL.featured], p.id)
    }
    setPool((prev) => prev.map((x) => (x.id === p.id ? { ...x, featured: !x.featured } : x)))
  }

  return (
    <div>
      <p style={{ ...S.sub, marginBottom: 14 }}>홈 화면 상단에 2초 간격으로 돌아가며 보여줄 대표사진을 최대 5장 선택하세요. ({featuredCount}/5)</p>
      {loading ? <div>불러오는 중…</div> : (
        groups.length === 0 ? <div style={{ color: COLORS.sub }}>등록된 사진이 없습니다.</div> : (
          groups.map((g) => (
            <div key={g.tripId} style={{ marginBottom: 24 }}>
              <div style={{ fontWeight: 800, color: COLORS.blueDark, marginBottom: 10, fontSize: 16 }}>
                🗓️ {g.tripTitle} {g.tripDate ? `· ${fmtDateLong(g.tripDate)}` : ''}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 10 }}>
                {g.items.map((p) => (
                  <div key={p.id} onClick={() => toggle(p)} style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', aspectRatio: '1/1', cursor: 'pointer', border: p.featured ? `4px solid ${COLORS.greenBright}` : `2px solid ${COLORS.border}` }}>
                    <img src={toThumbUrl(p.url, 300)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    {p.featured && <div style={{ position: 'absolute', top: 4, right: 4, background: COLORS.greenBright, color: '#fff', borderRadius: 8, padding: '2px 8px', fontSize: 13, fontWeight: 800 }}>★ 대표</div>}
                  </div>
                ))}
              </div>
            </div>
          ))
        )
      )}
    </div>
  )
}

/* ══════════════════════════════════════
   관리자 - 문의 알림 휴대폰번호 설정
══════════════════════════════════════ */
function AdminNotifyTab({ showToast }) {
  const config = useDoc([COL.config], 'notify')
  const [phone, setPhone] = useState('')

  useEffect(() => { setPhone(config?.phone || '') }, [config?.phone])

  const save = async () => {
    const digits = phone.replace(/[^0-9]/g, '')
    if (digits.length < 9) { showToast('휴대폰번호를 정확히 입력해주세요.', 'error'); return }
    await fsSet([COL.config], 'notify', { phone: digits })
    showToast('알림 받을 휴대폰번호가 저장되었습니다.')
  }

  return (
    <div>
      <p style={{ ...S.sub, marginBottom: 14 }}>문의하기가 접수되면 문자로 알려드릴 휴대폰번호입니다.</p>
      <div style={S.label}>휴대폰번호</div>
      <input style={{ ...S.input, maxWidth: 320, marginBottom: 12 }} placeholder="010-0000-0000" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <div>
        <button onClick={save} style={S.btn(COLORS.blue)}>저장</button>
      </div>
      <div style={{ fontSize: 14, color: COLORS.sub, marginTop: 14, lineHeight: 1.7 }}>
        · 문자 발송을 실제로 사용하려면 문자 발송 서비스(Solapi) 연동 설정이 필요합니다. (README 참고)<br />
        · 설정 전에도 문의 내용은 홈페이지에 정상적으로 접수·저장됩니다.
      </div>
    </div>
  )
}

/* ══════════════════════════════════════
   관리자 패널
══════════════════════════════════════ */
function AdminPanel({ notices, trips, showToast }) {
  const [tab, setTab] = useState('featured')
  const tabs = [
    ['featured', '⭐ 대표사진'],
    ['notices', '📢 공지 현황'],
    ['trips', '📷 여행 현황'],
    ['notify', '📱 문의 알림'],
  ]
  return (
    <div style={S.page}>
      <h1 style={S.h1}>⚙️ 관리자 메뉴</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {tabs.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            background: tab === k ? COLORS.blue : '#fff', color: tab === k ? '#fff' : COLORS.blueDark,
            border: `2px solid ${COLORS.blue}`, borderRadius: 14, padding: '11px 18px', fontSize: 16, fontWeight: 800,
          }}>{l}</button>
        ))}
      </div>
      <div style={S.card}>
        {tab === 'featured' && <AdminFeaturedTab trips={trips} showToast={showToast} />}
        {tab === 'notices' && (
          <div>
            <p style={S.sub}>공지사항 등록·수정·삭제는 <b>공지사항</b> 메뉴에서 바로 할 수 있어요. (총 {notices.length}건)</p>
          </div>
        )}
        {tab === 'trips' && (
          <div>
            <p style={S.sub}>여행 등록·삭제와 사진·영상 관리는 <b>여행앨범</b> 메뉴에서 바로 할 수 있어요. (총 {trips.length}건)</p>
          </div>
        )}
        {tab === 'notify' && <AdminNotifyTab showToast={showToast} />}
      </div>
    </div>
  )
}

/* ══════════════════════════════════════
   앱 루트
══════════════════════════════════════ */
export default function App() {
  const [page, setPage] = useState('home')
  const [tripId, setTripId] = useState(null)
  const [showLogin, setShowLogin] = useState(false)
  const [isAdmin, setIsAdmin] = useState(() => sessionStorage.getItem(ADMIN_SESSION_KEY) === 'yes')
  const [toast, setToast] = useState(null)

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type }); setTimeout(() => setToast(null), 3200)
  }, [])

  const go = (p, id = null) => { setPage(p); setTripId(id); window.scrollTo(0, 0) }

  useEffect(() => { ensureSeedData() }, [])

  const { data: notices } = useCollection([COL.notices])
  const { data: trips } = useCollection([COL.trips], 'date', 'desc')
  const { data: featured } = useCollection([COL.featured], 'addedAt', 'asc', 5)

  const onAdminSuccess = () => {
    sessionStorage.setItem(ADMIN_SESSION_KEY, 'yes')
    setIsAdmin(true); setShowLogin(false)
    showToast('관리자로 로그인했습니다.')
  }
  const onAdminLogout = () => {
    sessionStorage.removeItem(ADMIN_SESSION_KEY)
    setIsAdmin(false); go('home')
    showToast('로그아웃되었습니다.')
  }

  const renderPage = () => {
    switch (page) {
      case 'home': return <HomePage go={go} notices={notices} trips={trips} featured={featured} />
      case 'notices': return <NoticesPage notices={notices} isAdmin={isAdmin} showToast={showToast} />
      case 'trips': return <TripsPage trips={trips} go={go} isAdmin={isAdmin} showToast={showToast} />
      case 'tripDetail': return <TripDetailPage tripId={tripId} trips={trips} go={go} isAdmin={isAdmin} showToast={showToast} />
      case 'inquiry': return <InquiryPage isAdmin={isAdmin} showToast={showToast} />
      case 'admin': return isAdmin
        ? <AdminPanel notices={notices} trips={trips} showToast={showToast} />
        : <div style={{ ...S.page, textAlign: 'center', color: COLORS.danger }}>⛔ 관리자만 접근할 수 있습니다.</div>
      default: return <HomePage go={go} notices={notices} trips={trips} featured={featured} />
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: COLORS.bg }}>
      <Header page={page} go={go} isAdmin={isAdmin} onAdminLogin={() => setShowLogin(true)} onAdminLogout={onAdminLogout} />
      <div style={{ maxWidth: 980, margin: '20px auto 0', padding: '0 18px' }}>
        <ConfigWarning />
      </div>
      <main>{renderPage()}</main>
      <footer style={{ textAlign: 'center', padding: '30px 16px', color: COLORS.sub, fontSize: 15 }}>
        © {new Date().getFullYear()} {CLUB_NAME}
      </footer>
      {showLogin && <AdminLoginModal onClose={() => setShowLogin(false)} onSuccess={onAdminSuccess} showToast={showToast} />}
      <Toast toast={toast} />
    </div>
  )
}
