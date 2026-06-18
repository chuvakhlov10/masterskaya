import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// ── универсальные helpers ──────────────────────────────────────
export async function dbGet(key) {
  const { data } = await supabase
    .from('kv_store')
    .select('value')
    .eq('key', key)
    .single()
  return data ? data.value : null
}

export async function dbSet(key, value) {
  await supabase
    .from('kv_store')
    .upsert({ key, value }, { onConflict: 'key' })
}
