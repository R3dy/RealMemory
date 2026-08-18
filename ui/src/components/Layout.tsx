import { Outlet } from 'react-router';
import Navbar from './Navbar';
import NavRail from './NavRail';
import Footer from './Footer';

/**
 * App shell — Navbar (top HUD) + NavRail (left) + content slot + Footer strip.
 * Content slot owns the remaining viewport; pages must not add nav offsets.
 */
export default function Layout() {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-void text-hi">
      <div className="nebula-backdrop" />
      <div className="vignette" />
      <div className="scanlines" />
      <Navbar />
      <div className="flex min-h-0 flex-1">
        <NavRail />
        <main className="relative min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
      <Footer />
    </div>
  );
}
