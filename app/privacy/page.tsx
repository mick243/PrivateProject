import Link from 'next/link';
import { CONTACT_EMAIL, LEGAL_EFFECTIVE_DATE, LEGAL_PLACEHOLDERS_PRESENT, OPERATOR_NAME } from '@/lib/legal';

export const metadata = {
  title: '개인정보처리방침',
  description: '오락실 파인더 개인정보처리방침',
};

/**
 * 개인정보처리방침.
 *
 * 항목은 **실제로 저장하는 것**만 적었습니다 (players · player_identities · 로그인 실패
 * 카운터 · 업로드). 코드가 바뀌어 수집 항목이 늘면 이 문서도 같이 고쳐야 합니다 —
 * 예: 이메일 인증을 붙이면 "이메일" 항목과 보존 기간이 추가됩니다.
 *
 * ⚠ 초안입니다. 운영자 정보는 env(lib/legal.ts). 법률 검토를 대신하지 않습니다.
 */
export default function PrivacyPage() {
  return (
    <main className="legal-page">
      <article className="legal">
        <h1>개인정보처리방침</h1>
        <p className="muted small">시행일 {LEGAL_EFFECTIVE_DATE}</p>
        {LEGAL_PLACEHOLDERS_PRESENT && (
          <p className="warn">
            운영자 정보가 설정되지 않았습니다 — <code>NEXT_PUBLIC_OPERATOR_NAME</code> ·{' '}
            <code>NEXT_PUBLIC_CONTACT_EMAIL</code> 을 채우세요. (이 경고는 값이 있으면 사라집니다)
          </p>
        )}
        <p>
          {OPERATOR_NAME}(이하 &quot;운영자&quot;)은 오락실 파인더(이하 &quot;서비스&quot;)를 운영하면서
          다음과 같이 개인정보를 처리합니다.
        </p>

        <h2>1. 수집하는 개인정보와 목적</h2>
        <table>
          <thead>
            <tr>
              <th>항목</th>
              <th>수집 시점</th>
              <th>목적</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>아이디(닉네임), 비밀번호(암호화 저장)</td>
              <td>회원가입</td>
              <td>계정 식별, 로그인, 게시물의 작성자 표시</td>
            </tr>
            <tr>
              <td>소셜 계정 식별자(Google·카카오·네이버가 발급한 고유 번호), 소셜 계정의 이메일(제공되는 경우)</td>
              <td>소셜 로그인</td>
              <td>같은 계정으로 다시 로그인했는지 확인</td>
            </tr>
            <tr>
              <td>접속 IP 주소(프록시가 전달한 값)</td>
              <td>로그인·가입·제보 요청</td>
              <td>비밀번호 대입·대량 가입·스팸 제보 등 남용 방지 (시도 횟수 카운터)</td>
            </tr>
            <tr>
              <td>이용자가 작성한 제보·리뷰·글·댓글·첨부 이미지/영상</td>
              <td>작성 시</td>
              <td>서비스 제공(다른 이용자에게 표시)</td>
            </tr>
            <tr>
              <td>챗봇에 입력한 질문</td>
              <td>챗봇 이용 시</td>
              <td>답변 생성 (아래 3항의 처리 위탁 참고)</td>
            </tr>
          </tbody>
        </table>
        <p>
          <strong>위치정보</strong>: &quot;내 위치&quot; 기능은 브라우저의 위치 권한을 받아 기기에서
          현재 위치를 읽고, 이를 <strong>주변 오락실 검색 요청의 기준 좌표로만</strong> 서버에 보냅니다.
          위치는 저장하지 않으며, 계정과 연결하지 않고, 이동 경로를 기록하지 않습니다. 권한을 끄면
          기능만 꺼지고 나머지 서비스는 그대로 이용할 수 있습니다.
        </p>
        <p>
          <strong>쿠키</strong>: 로그인 상태 유지를 위한 세션 쿠키(7일) 하나와, 소셜 로그인 진행 중에만
          쓰는 임시 쿠키를 사용합니다. 광고·추적 쿠키는 쓰지 않습니다.
        </p>

        <h2>2. 보유 기간</h2>
        <ul>
          <li>계정 정보: 탈퇴 시까지. 탈퇴하면 즉시 삭제합니다.</li>
          <li>게시물: 탈퇴 시 글·댓글·리뷰·채보 평가·즐겨찾기는 삭제하고, 오락실 제보는 작성자 정보를 지워 익명으로 남깁니다(지도 정보의 근거).</li>
          <li>시도 횟수 카운터(IP·계정 키): 마지막 기록 후 최대 1일.</li>
          <li>세션 쿠키: 발급 후 7일 또는 로그아웃 시.</li>
        </ul>

        <h2>3. 제3자 제공과 처리 위탁</h2>
        <p>개인정보를 제3자에게 판매하거나 제공하지 않습니다. 서비스 제공을 위해 다음 사업자의 도구를 사용합니다.</p>
        <ul>
          <li>네이버클라우드(지도 표시·지역 검색): 지도 타일 요청과 검색어가 전달됩니다.</li>
          <li>Google(Gemini API, 챗봇): 이용자가 챗봇에 입력한 질문과 대화 맥락이 답변 생성을 위해 전달됩니다. 계정 정보는 전달하지 않습니다.</li>
          <li>Google·카카오·네이버(소셜 로그인): 로그인 과정에서 해당 사업자의 약관이 함께 적용됩니다.</li>
        </ul>

        <h2>4. 이용자의 권리</h2>
        <ul>
          <li>계정 관리 화면(<Link href="/account">/account</Link>)에서 닉네임·비밀번호를 바꾸고, 계정을 탈퇴할 수 있습니다.</li>
          <li>자신이 쓴 글·댓글·리뷰는 화면에서 직접 삭제할 수 있습니다.</li>
          <li>그 밖의 열람·정정·삭제 요청은 아래 연락처로 보내 주세요. 10일 안에 답합니다.</li>
        </ul>

        <h2>5. 만 14세 미만</h2>
        <p>만 14세 미만의 개인정보는 수집하지 않습니다. 가입 시 만 14세 이상임을 확인하며, 미만임이 확인되면 계정을 삭제합니다.</p>

        <h2>6. 안전성 확보 조치</h2>
        <ul>
          <li>비밀번호는 복원할 수 없는 방식(scrypt)으로 암호화해 저장합니다.</li>
          <li>세션 쿠키는 HttpOnly·Secure 속성으로 스크립트 접근을 막습니다.</li>
          <li>로그인·가입·제보에 시도 횟수 제한을 둡니다.</li>
          <li>관리자 권한은 요청마다 다시 확인합니다.</li>
        </ul>

        <h2>7. 개인정보 보호책임자·문의</h2>
        <p>
          {OPERATOR_NAME} · <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          <br />
          부적절한 게시물 신고도 같은 주소로 보내 주세요. 개인정보 침해에 대한 신고·상담은
          개인정보침해신고센터(privacy.kisa.or.kr · 118)에서도 받습니다.
        </p>

        <h2>8. 방침의 변경</h2>
        <p>이 방침을 바꿀 때는 시행일 7일 전부터 서비스 안에서 알립니다.</p>

        <p className="legal-links">
          <Link href="/terms">이용약관</Link> · <Link href="/finder">오락실 파인더로</Link>
        </p>
      </article>
    </main>
  );
}
