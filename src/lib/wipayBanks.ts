// What WiPay Jamaica accepts for a bank payout, from its public withdrawal
// metadata (GET https://jmsb.wipayfinancial.com/wapi/withdrawals/meta, read
// 14 Oct 2026). `name` is the value WiPay's API expects as bank_name.
// Re-check against the metadata endpoint if WiPay adds a bank.

export const WIPAY_JAMAICA_BANKS = [
  { name: 'National Commercial Bank', displayName: 'National Commercial Bank Jamaica Limited' },
  { name: 'Scotiabank Jamaica', displayName: 'The Bank of Nova Scotia Jamaica Limited' },
  { name: 'JN Bank', displayName: 'JN Bank Limited' },
  { name: 'JMMB', displayName: 'JMMB Bank (Jamaica) Limited' },
  { name: 'Sagicor Bank', displayName: 'Sagicor Bank Jamaica Limited' },
  { name: 'First Global Bank', displayName: 'First Global Bank Limited' },
  { name: 'CIBC First Caribbean', displayName: 'FirstCaribbean International Bank (Jamaica) Limited' },
  { name: 'Citibank', displayName: 'Citibank N.A.' },
] as const;

export const WIPAY_BANK_NAMES = WIPAY_JAMAICA_BANKS.map((b) => b.name) as [string, ...string[]];

// Our ID types, WiPay's name for each, and the format WiPay validates.
export const WIPAY_ID_TYPES = {
  DRIVER_PERMIT: { wipay: 'driver_permit', pattern: /^[0-9]{9}$/, label: "Driver's licence (TRN-style, 9 digits)" },
  NATIONAL_ID: { wipay: 'national_id', pattern: /^[0-9]{7}$/, label: 'National ID (7 digits)' },
  PASSPORT: { wipay: 'passport', pattern: /^[A-Z][0-9]{7}$/, label: 'Passport (a letter then 7 digits)' },
} as const;
