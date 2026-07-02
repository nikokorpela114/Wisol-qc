// src/supabaseClient.js
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://ddgsbamrafhasrtsrsyv.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRkZ3NiYW1yYWZoYXNydHNyc3l2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyODU2MzUsImV4cCI6MjA5Nzg2MTYzNX0.gsbIu5yAUA_iINCGF20p4bSAWJCaEN6UXi8_OlGC3Oc'

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY)
