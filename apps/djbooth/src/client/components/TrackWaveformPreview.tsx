import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { trackWaveformQueryOptions } from "../library-queries.js";
import { RgbWaveform } from "./RgbWaveform.js";

export function TrackWaveformPreview({
  trackId,
  className,
}: {
  trackId: string;
  className: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (visible || !canvasRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: "300px 0px" },
    );
    observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [visible]);
  const query = useQuery({ ...trackWaveformQueryOptions(trackId), enabled: visible });

  return <RgbWaveform ref={canvasRef} waveform={query.data} className={className} />;
}
