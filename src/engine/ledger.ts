// 통화별 복식 장부. 한 분개는 한 통화만 사용하며 차변 합계와 대변 합계가 같아야 한다.
// USD 거래 장부와 KRW 급여 장부는 같은 구조를 쓰되 서로 합산하지 않는다.
// 직접 무역(상품 매출·매출원가)과 운송 주선(서비스 매출·주선 원가)은 계정을 나눠 섞지 않는다.

import { assertMinor, type Currency } from './money';

export type Account =
  | 'CASH'
  | 'INVENTORY'
  | 'PREPAID_FREIGHT'
  | 'FORWARDING_WIP'
  | 'ACCOUNTS_RECEIVABLE'
  | 'ACCOUNTS_PAYABLE'
  | 'OPENING_EQUITY'
  | 'REVENUE'
  | 'SALES_ALLOWANCE'
  | 'COST_OF_GOODS_SOLD'
  | 'FORWARDING_REVENUE'
  | 'FORWARDING_COST'
  | 'RECEIVABLE_CARRY'
  | 'BAD_DEBT'
  | 'CANCELLATION_EXPENSE'
  | 'WAGE_EXPENSE'
  | 'RECRUITMENT_EXPENSE'
  | 'TRAINING_EXPENSE'
  | 'CULTURE_EXPENSE'
  | 'RENT_EXPENSE'
  | 'FACILITY_SETUP_EXPENSE'
  | 'SPACE_CONTRACT_EXPENSE'
  | 'FX_SPREAD_EXPENSE'
  | 'CURRENCY_TRANSFER';

type AccountKind = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export const ACCOUNT_KIND: Record<Account, AccountKind> = {
  CASH: 'asset',
  INVENTORY: 'asset',
  PREPAID_FREIGHT: 'asset',
  /** 출항한 운송 주선 화물의 운임. 인도해 서비스 매출을 인식할 때 주선 원가로 옮긴다. */
  FORWARDING_WIP: 'asset',
  ACCOUNTS_RECEIVABLE: 'asset',
  ACCOUNTS_PAYABLE: 'liability',
  OPENING_EQUITY: 'equity',
  REVENUE: 'income',
  SALES_ALLOWANCE: 'income',
  COST_OF_GOODS_SOLD: 'expense',
  FORWARDING_REVENUE: 'income',
  FORWARDING_COST: 'expense',
  RECEIVABLE_CARRY: 'expense',
  BAD_DEBT: 'expense',
  CANCELLATION_EXPENSE: 'expense',
  WAGE_EXPENSE: 'expense',
  RECRUITMENT_EXPENSE: 'expense',
  TRAINING_EXPENSE: 'expense',
  CULTURE_EXPENSE: 'expense',
  RENT_EXPENSE: 'expense',
  FACILITY_SETUP_EXPENSE: 'expense',
  SPACE_CONTRACT_EXPENSE: 'expense',
  FX_SPREAD_EXPENSE: 'expense',
  CURRENCY_TRANSFER: 'equity',
};

/** amount > 0 은 차변, amount < 0 은 대변. */
export interface LedgerLine {
  account: Account;
  amount: number;
}

export interface LedgerEntry {
  id: string;
  day: number;
  currency: Currency;
  lines: LedgerLine[];
  /** 발생 이유. 화면의 원인 설명과 감사 추적에 사용한다. */
  reason: string;
  contractId?: string;
}

export interface Ledger {
  entries: LedgerEntry[];
  /** 이미 기록한 분개 ID. 같은 ID의 재처리를 막는다. */
  postedIds: Record<string, true>;
}

export class LedgerError extends Error {}

export function emptyLedger(): Ledger {
  return { entries: [], postedIds: {} };
}

export function isPosted(ledger: Ledger, entryId: string): boolean {
  return ledger.postedIds[entryId] === true;
}

/**
 * 분개를 기록한다. 같은 ID가 이미 있으면 아무것도 바꾸지 않고 false를 돌려준다.
 * 상태를 직접 변경하는 함수이며, 엔진은 복제한 상태에만 호출한다.
 */
export function post(ledger: Ledger, entry: LedgerEntry): boolean {
  if (isPosted(ledger, entry.id)) return false;
  if (entry.lines.length < 2) throw new LedgerError(`${entry.id}: 분개에는 두 줄 이상이 필요합니다.`);
  let sum = 0;
  for (const line of entry.lines) {
    assertMinor(line.amount, `${entry.id}.${line.account}`);
    if (line.amount === 0) throw new LedgerError(`${entry.id}: 0원 분개 줄은 기록하지 않습니다.`);
    sum += line.amount;
  }
  if (sum !== 0) throw new LedgerError(`${entry.id}: 차변과 대변이 일치하지 않습니다 (차이 ${sum}).`);
  ledger.entries.push({ ...entry, lines: entry.lines.map((l) => ({ ...l })) });
  ledger.postedIds[entry.id] = true;
  return true;
}

/** 계정 잔액을 정상 잔액 방향(자산·비용은 차변, 부채·자본·수익은 대변)의 양수로 돌려준다. */
export function balance(ledger: Ledger, currency: Currency, account: Account): number {
  let debit = 0;
  for (const entry of ledger.entries) {
    if (entry.currency !== currency) continue;
    for (const line of entry.lines) if (line.account === account) debit += line.amount;
  }
  const kind = ACCOUNT_KIND[account];
  return kind === 'asset' || kind === 'expense' ? debit : 0 - debit;
}

/** 특정 계약에 귀속된 계정의 순발생액(정상 잔액 방향). 계약별 기여이익 계산에 사용한다. */
export function contractAmount(
  ledger: Ledger,
  currency: Currency,
  contractId: string,
  account: Account,
): number {
  let debit = 0;
  for (const entry of ledger.entries) {
    if (entry.currency !== currency || entry.contractId !== contractId) continue;
    for (const line of entry.lines) if (line.account === account) debit += line.amount;
  }
  const kind = ACCOUNT_KIND[account];
  return kind === 'asset' || kind === 'expense' ? debit : 0 - debit;
}

export interface BookSummary {
  currency: Currency;
  cash: number;
  inventory: number;
  prepaidFreight: number;
  forwardingWip: number;
  accountsReceivable: number;
  accountsPayable: number;
  totalAssets: number;
  /** 상품 매출 (직접 무역). */
  revenue: number;
  costOfGoodsSold: number;
  /** 운송 주선 서비스 매출과 그 직접 원가. 상품 매출에 더하지 않는다. */
  forwardingRevenue: number;
  forwardingCost: number;
  cancellationExpense: number;
  wageExpense: number;
  recruitmentExpense: number;
  trainingExpense: number;
  cultureExpense: number;
  rentExpense: number;
  facilitySetupExpense: number;
  spaceContractExpense: number;
  fxSpreadExpense: number;
  currencyTransferNet: number;
  profit: number;
  openingEquity: number;
}

export function summarize(ledger: Ledger, currency: Currency): BookSummary {
  const b = (a: Account) => balance(ledger, currency, a);
  const cash = b('CASH');
  const inventory = b('INVENTORY');
  const prepaidFreight = b('PREPAID_FREIGHT');
  const forwardingWip = b('FORWARDING_WIP');
  const accountsReceivable = b('ACCOUNTS_RECEIVABLE');
  const revenue = b('REVENUE');
  const costOfGoodsSold = b('COST_OF_GOODS_SOLD');
  const forwardingRevenue = b('FORWARDING_REVENUE');
  const forwardingCost = b('FORWARDING_COST');
  const cancellationExpense = b('CANCELLATION_EXPENSE');
  const wageExpense = b('WAGE_EXPENSE');
  const recruitmentExpense = b('RECRUITMENT_EXPENSE');
  const trainingExpense = b('TRAINING_EXPENSE');
  const cultureExpense = b('CULTURE_EXPENSE');
  const rentExpense = b('RENT_EXPENSE');
  const facilitySetupExpense = b('FACILITY_SETUP_EXPENSE');
  const spaceContractExpense = b('SPACE_CONTRACT_EXPENSE');
  const fxSpreadExpense = b('FX_SPREAD_EXPENSE');
  const currencyTransferNet = b('CURRENCY_TRANSFER');
  return {
    currency,
    cash,
    inventory,
    prepaidFreight,
    forwardingWip,
    accountsReceivable,
    accountsPayable: b('ACCOUNTS_PAYABLE'),
    totalAssets: cash + inventory + prepaidFreight + forwardingWip + accountsReceivable,
    revenue,
    costOfGoodsSold,
    forwardingRevenue,
    forwardingCost,
    cancellationExpense,
    wageExpense,
    recruitmentExpense,
    trainingExpense,
    cultureExpense,
    rentExpense,
    facilitySetupExpense,
    spaceContractExpense,
    fxSpreadExpense,
    currencyTransferNet,
    profit: revenue + b('SALES_ALLOWANCE') - costOfGoodsSold + forwardingRevenue - forwardingCost - cancellationExpense - wageExpense - recruitmentExpense - trainingExpense - cultureExpense - rentExpense - facilitySetupExpense - spaceContractExpense - fxSpreadExpense - b('RECEIVABLE_CARRY') - b('BAD_DEBT'),
    openingEquity: b('OPENING_EQUITY'),
  };
}
