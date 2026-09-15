import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'

/**
 * 무료 Firebase Firestore를 데이터베이스로 사용합니다.
 * 실제 서비스 전에는 Firebase 콘솔에서 새 프로젝트를 만들고
 * 아래 값을 새 프로젝트의 설정 값으로 교체해 주세요.
 * (Firestore는 사진/영상 원본 파일이 아니라 글, 날짜, 파일 링크 같은
 *  "가벼운 정보"만 저장하고, 실제 사진/영상은 Cloudinary에 저장합니다.)
 */
const firebaseConfig = {
  apiKey: "AIzaSyAzVaXVRvA1CdQhtk-g3It_0V2jcRPnXZQ",
  authDomain: "evlaser-resort-2026.firebaseapp.com",
  projectId: "evlaser-resort-2026",
  storageBucket: "evlaser-resort-2026.firebasestorage.app",
  messagingSenderId: "847525238674",
  appId: "1:847525238674:web:a46d5d4c7b87d2c3a2534b"
}

const app = initializeApp(firebaseConfig)
export const db = getFirestore(app)

/**
 * Firestore 컬렉션 이름 모음 (여행동호회 홈페이지 전용)
 *   notices          공지사항
 *   trips            여행(날짜별) 목록
 *   trips/{id}/media 각 여행의 사진·영상·자료
 *   inquiries        문의하기
 *   featured         홈 화면에 표시할 대표사진(최대 5장)
 */
export const COL = {
  notices: 'club_notices',
  trips: 'club_trips',
  media: 'media',
  inquiries: 'club_inquiries',
  featured: 'club_featured',
}
