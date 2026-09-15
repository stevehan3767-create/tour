/**
 * 사진 · 영상 · 자료 업로드를 위한 Cloudinary 연동 헬퍼.
 *
 * Cloudinary 무료 요금제는 저장공간 25GB, 매월 전송량 25GB를 제공하여
 * (신용카드 등록 없이 가입 가능) 여행 사진/영상을 넉넉하게 무료로 보관할 수 있습니다.
 *
 * 사용 방법:
 *  1) https://cloudinary.com 에서 무료 계정 생성
 *  2) Dashboard에서 "Cloud name" 확인
 *  3) Settings → Upload → Upload presets → "Add upload preset"
 *     - Signing Mode: Unsigned 로 설정
 *     - Incoming Transformation은 비워두어(설정하지 않아) 사진 원본 해상도가 그대로 저장되게 합니다.
 *  4) 프로젝트 루트에 .env 파일을 만들고 아래 두 값을 채웁니다.
 *       VITE_CLOUDINARY_CLOUD_NAME=여기에_클라우드이름
 *       VITE_CLOUDINARY_UPLOAD_PRESET=여기에_업로드프리셋이름
 */

const CLOUD_NAME = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME
const UPLOAD_PRESET = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET

export const isCloudinaryReady = () => Boolean(CLOUD_NAME && UPLOAD_PRESET)

export const VIDEO_MAX_BYTES = 100 * 1024 * 1024 // 100MB
export const MAX_PHOTOS_PER_PERSON_PER_TRIP = 10

/**
 * 파일을 Cloudinary로 업로드합니다. (사진/영상/문서 모두 auto 엔드포인트 사용)
 * onProgress(percent:number) 콜백으로 업로드 진행률을 전달합니다.
 */
export function uploadToCloudinary(file, onProgress) {
  if (!isCloudinaryReady()) {
    return Promise.reject(new Error('CLOUDINARY_NOT_CONFIGURED'))
  }
  const url = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/auto/upload`
  const form = new FormData()
  form.append('file', file)
  form.append('upload_preset', UPLOAD_PRESET)

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          reject(new Error('업로드 응답을 처리하지 못했습니다.'))
        }
      } else {
        let msg = '업로드에 실패했습니다.'
        try { msg = JSON.parse(xhr.responseText)?.error?.message || msg } catch {}
        reject(new Error(msg))
      }
    }
    xhr.onerror = () => reject(new Error('네트워크 오류로 업로드에 실패했습니다.'))
    xhr.send(form)
  })
}

/** 사진/영상을 "다운로드"용 링크로 바꿉니다 (브라우저에서 열지 않고 저장되도록). */
export function toDownloadUrl(secureUrl, filename) {
  if (!secureUrl) return secureUrl
  const flag = filename ? `fl_attachment:${encodeURIComponent(filename)}` : 'fl_attachment'
  if (secureUrl.includes('/upload/')) {
    return secureUrl.replace('/upload/', `/upload/${flag}/`)
  }
  return secureUrl
}

/**
 * 목록/그리드에서 빠르게 보여줄 축소판 URL을 만듭니다.
 * (원본 파일 자체는 그대로 저장되고, 화면에 보여줄 때만 작게 변환해서 데이터 사용량을 아낍니다)
 */
export function toThumbUrl(secureUrl, width = 480) {
  if (!secureUrl) return secureUrl
  if (secureUrl.includes('/upload/')) {
    return secureUrl.replace('/upload/', `/upload/w_${width},c_limit,q_auto,f_auto/`)
  }
  return secureUrl
}

export function humanSize(bytes) {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
