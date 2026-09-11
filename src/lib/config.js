// Anon/publishable keys are meant to be public -- every write they allow is
// gated by Postgres row-level security policies on the backend, not by
// keeping this key secret. See the RLS policies in the Supabase project.
export const SUPABASE_URL = 'https://ywwdgwiqoeqixmbvibeq.supabase.co'
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3d2Rnd2lxb2VxaXhtYnZpYmVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwODIxNjIsImV4cCI6MjEwNDY1ODE2Mn0.tVc8mNMHF158qM0x5yzjusdYJSZVfnZCfJLfz9TXD-w'
