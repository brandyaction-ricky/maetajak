const blockedStates = {
  PENDING: { status: '승인 대기', detail: '관리자가 가입 정보를 확인한 뒤 승인합니다.' },
  REJECTED: { status: '가입 거절', detail: '관리자에게 가입 상태를 문의해 주세요.' },
  SUSPENDED: { status: '이용 중지', detail: '현재 계정은 서비스 이용이 중지되었습니다.' },
};

export function getAccessDecision(profile) {
  if (profile?.approval_status === 'APPROVED') {
    return { allowed: true, role: profile.role === 'ADMIN' ? 'admin' : 'member' };
  }
  return {
    allowed: false,
    ...(blockedStates[profile?.approval_status] || { status: '접근 제한', detail: '계정 상태를 확인할 수 없습니다.' }),
  };
}
