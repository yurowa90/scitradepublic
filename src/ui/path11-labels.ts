import type { Account } from '../engine/ledger';

// 회계 분류는 교사 검토 전 임시 문구다(2026-10-31 결정 4).
export const SETTLEMENT_LINE_KO: Record<Account | 'fxTranslationKrwMinor', string> = {
  CASH: '현금', INVENTORY: '재고', PREPAID_FREIGHT: '선급운임', FORWARDING_WIP: '주선 진행원가',
  ACCOUNTS_RECEIVABLE: '받을 돈', ACCOUNTS_PAYABLE: '미지급금', OPENING_EQUITY: '시작 자본',
  REVENUE: '상품 매출', SALES_ALLOWANCE: '매출 감액',
  COST_OF_GOODS_SOLD: '매출원가 · 관세는 매입원가에 넣음(K-IFRS 1002.11)',
  FORWARDING_REVENUE: '주선 매출', FORWARDING_COST: '주선 원가', RECEIVABLE_CARRY: '미수 유지비', BAD_DEBT: '확정 대손',
  CANCELLATION_EXPENSE: '취소 비용', WAGE_EXPENSE: '급여', RECRUITMENT_EXPENSE: '영입 계약금',
  TRAINING_EXPENSE: '훈련비', CULTURE_EXPENSE: '현지 활동비', RENT_EXPENSE: '임차료',
  FACILITY_SETUP_EXPENSE: '시설 설치비', SPACE_CONTRACT_EXPENSE: '선복 계약비',
  FX_SPREAD_EXPENSE: '환전 비용 · 환전 손익은 영업이익 밖(K-IFRS 1001 한138.2), 국내 기준 이름은 영업외손익',
  CURRENCY_TRANSFER: '통화 간 자금 이동', fxTranslationKrwMinor: '환율 변동 손익',
};
