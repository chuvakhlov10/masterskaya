import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// ── универсальные helpers ──────────────────────────────────────
export async function dbGet(key) {
  try {
    const { data, error } = await supabase
      .from('kv_store')
      .select('value')
      .eq('key', key)
      .single()
    if (error) {
      // PGRST116 = no rows found — это нормально, вернём null
      if (error.code === 'PGRST116') return null
      console.warn(`dbGet("${key}") error:`, error)
      return null
    }
    return data ? data.value : null
  } catch (e) {
    console.warn(`dbGet("${key}") exception:`, e)
    return null
  }
}

export async function dbSet(key, value) {
  try {
    const { error } = await supabase
      .from('kv_store')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    if (error) {
      console.error(`dbSet("${key}") error:`, error)
    }
  } catch (e) {
    console.error(`dbSet("${key}") exception:`, e)
  }
}

