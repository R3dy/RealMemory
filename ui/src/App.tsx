import { Routes, Route } from 'react-router';
import Layout from './components/Layout';
import Home from './pages/Home';
import Memories from './pages/Memories';
import Domains from './pages/Domains';
import Brain from './pages/Brain';
import Health from './pages/Health';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="memories" element={<Memories />} />
        <Route path="domains" element={<Domains />} />
        <Route path="brain" element={<Brain />} />
        <Route path="vitals" element={<Health />} />
        <Route path="*" element={<Home />} />
      </Route>
    </Routes>
  );
}
