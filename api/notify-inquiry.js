import crypto from 'crypto'

/**
 * 문의하기가 접수되면 관리자 휴대폰으로 문자를 보내는 Vercel 서버리스 함수입니다.
 * 문자 발송은 Solapi(https://solapi.com)를 사용합니다. 아래 세 값을 Vercel
 * 프로젝트의 환경변수로 설정해야 실제로 문자가 발송됩니다. (README 참고)
 *   SOLAPI_API_KEY       Solapi API Key
 *   SOLAPI_API_SECRET    Solapi API Secret
 *   SOLAPI_SENDER_NUMBER Solapi에 등록·인증한 발신 번호 (숫자만, 예: 01012345678)
 *
 * 위 값이 설정되어 있지 않아도 문의 자체는 정상적으로 접수되며(App.jsx에서
 * Firestore 저장은 이 함수와 무관하게 먼저 처리됩니다), 이 함수는 문자
 * 발송을 시도만 하고 실패해도 에러를 던지지 않습니다.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  const { name, contact, message, to } = req.body || {}
  const apiKey = process.env.SOLAPI_API_KEY
  const apiSecret = process.env.SOLAPI_API_SECRET
  const from = process.env.SOLAPI_SENDER_NUMBER
  const toDigits = String(to || '').replace(/[^0-9]/g, '')

  if (!apiKey || !apiSecret || !from) {
    res.status(200).json({ sent: false, reason: 'SOLAPI 환경변수가 설정되지 않았습니다.' })
    return
  }
  if (!toDigits) {
    res.status(200).json({ sent: false, reason: '받는 사람 번호가 없습니다.' })
    return
  }

  try {
    const date = new Date().toISOString()
    const salt = crypto.randomBytes(16).toString('hex')
    const signature = crypto.createHmac('sha256', apiSecret).update(date + salt).digest('hex')
    const text = `[여행동호회 문의]\n이름: ${name}\n연락처: ${contact}\n${message}`.slice(0, 1990)

    const r = await fetch('https://api.solapi.com/messages/v4/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`,
      },
      body: JSON.stringify({ message: { to: toDigits, from, text } }),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) {
      res.status(200).json({ sent: false, error: data })
      return
    }
    res.status(200).json({ sent: true })
  } catch (e) {
    res.status(200).json({ sent: false, error: String(e) })
  }
}
