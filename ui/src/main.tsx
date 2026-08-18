import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'
import { initDataSource } from './lib/data'

// Boot the data source BEFORE first render: tries the live RealMemory API
// (?api= → localStorage → http://127.0.0.1:9333), then a persisted import,
// then the demo simulation. Async — the graph hot-swaps via dataVersion.
void initDataSource()

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
)
