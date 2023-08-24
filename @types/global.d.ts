type MemoryData = Map<string, (SystemData | UserData)>

interface SystemData {
  himawariCache: HimawariCache
  currencyData: CurrencyData
  responseTimer: number
  statusTimer: number
  reminderList: Array<Reminder>
}

interface Reminder {
  remindAt: number
  eventId: string
  eventPubkey: string
  content: string
}

interface CurrencyData {
  updateAt: number
  btc2usd: number
  btc2jpy: number
  usd2jpy: number
}

interface HimawariCache {
  lastHimawariDate: number
  lastHimawariUrl: string
}

interface UserData {
  counter: number
  failedTimer: number
  infoTimer: number
  loginBonus: LoginBonus
}

interface LoginBonus {
  lastLoginTime: number
  consecutiveLoginCount: number
  totalLoginCount: number
}

type Hits = import("meilisearch").Hits