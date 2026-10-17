import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import './index.css'
import App from './App.tsx'
import { deskQueryOptions } from './lib/queries'

const queryClient = new QueryClient({ defaultOptions: { queries: deskQueryOptions, mutations: { retry: false, gcTime: 0 } } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}><App /><Toaster position="bottom-right" richColors closeButton/></QueryClientProvider>
  </StrictMode>,
)
