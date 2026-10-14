import nikko from './nikko.json' with { type: 'json' }
import popls from './popls.json' with { type: 'json' }
import ryokuyou from './ryokuyou.json' with { type: 'json' }
import shimaya from './shimaya.json' with { type: 'json' }
import type { PrinterSpec } from './types.ts'

// JSON から読むと 'converted' などが string に広がるので型を当てる。形の正しさは check:specs で確かめている
export const PRINTERS = [nikko, ryokuyou, popls, shimaya] as PrinterSpec[]
