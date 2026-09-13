// Mirrors backend enums from app/l1_ingestion/schemas.py
export const VALID_CHANNELS = ['email', 'chat', 'voice', 'api'] as const
export const VALID_SOURCES = ['freshdesk', 'gmail', 'api', 'webhook'] as const
export const VALID_BUSINESS_LINES = ['ecommerce', 'fmcg', 'internal'] as const
export const VALID_MODULES = [
  'delivery',
  'quality',
  'payment',
  'fraud',
  'compliance',
  'food_safety',
  'fmcg',
  'operations',
] as const

export type Channel = (typeof VALID_CHANNELS)[number]
export type Source = (typeof VALID_SOURCES)[number]
export type BusinessLine = (typeof VALID_BUSINESS_LINES)[number]
export type Module = (typeof VALID_MODULES)[number]

export const PIPELINE_STAGES = {
  NEW: 'NEW',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const

export const VECTOR_JOB_STATUSES = ['pending', 'running', 'completed', 'failed'] as const
export type VectorJobStatus = (typeof VECTOR_JOB_STATUSES)[number]

export const KB_FORMATS = ['markdown', 'pdf', 'txt', 'json', 'docx'] as const
export type KBFormat = (typeof KB_FORMATS)[number]

// Sandbox preset tickets for demo
export const SANDBOX_PRESETS = [
  {
    label: 'Missing Delivery',
    data: {
      channel: 'email' as Channel,
      source: 'api' as Source,
      business_line: 'ecommerce' as BusinessLine,
      module: 'delivery' as Module,
      subject: 'Order not delivered',
      description: 'I placed an order 3 days ago and it has not been delivered yet. The app shows delivered but I have not received anything. Please help.',
    },
  },
  {
    label: 'Wrong Item',
    data: {
      channel: 'chat' as Channel,
      source: 'api' as Source,
      business_line: 'ecommerce' as BusinessLine,
      module: 'quality' as Module,
      subject: 'Wrong item received in my order',
      description: 'I ordered 500g basmati rice but received 500g regular rice. The item is completely wrong. I need a replacement or refund.',
    },
  },
  {
    label: 'Payment Issue',
    data: {
      channel: 'api' as Channel,
      source: 'api' as Source,
      business_line: 'ecommerce' as BusinessLine,
      module: 'payment' as Module,
      subject: 'Double charged for my order',
      description: 'My account was charged twice for order #ORD-12345. I can see two deductions of Rs.450 each in my bank statement but only placed one order.',
    },
  },
  {
    label: 'Fraud Flag',
    data: {
      channel: 'email' as Channel,
      source: 'api' as Source,
      business_line: 'ecommerce' as BusinessLine,
      module: 'fraud' as Module,
      subject: 'Unauthorized order placed on my account',
      description: 'There is an order placed on my account that I did not place. Someone seems to have accessed my account without authorization. Please investigate and refund.',
    },
  },
]
