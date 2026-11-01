import { useEffect, useRef, useState } from 'react';
import { createGenerationOrbRenderer } from './generation-orb-renderer.ts';

function OrbCanvas({ unavailable }: { unavailable: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const renderer = createGenerationOrbRenderer(canvas.current, unavailable);
    return () => renderer?.dispose();
  }, [unavailable]);
  return <canvas ref={canvas} className="generation-orb-canvas" />;
}

// A workbench-owned interpretation of the visible glossy sphere / slow internal swirl.
// This component is not the licensed React Bits Pro Agentic Ball component.
export function XiaoliuGenerationOrb({ animated }: { animated: boolean }) {
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [fallback, setFallback] = useState(false);
  const unavailable = useRef(() => setFallback(true)).current;
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => setReduced(media.matches);
    changed(); media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  const moving = animated && !reduced && !fallback;
  return <div className="generation-orb" data-motion={moving ? 'animated' : 'static'} data-renderer={moving ? 'webgl' : 'css'}>
    {moving ? <OrbCanvas unavailable={unavailable} /> : <div className="generation-orb-static" />}
  </div>;
}
