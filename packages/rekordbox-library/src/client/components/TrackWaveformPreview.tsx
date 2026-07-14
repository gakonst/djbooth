import { useQuery } from "@tanstack/react-query";

import { getTrackWaveform } from "../api.js";
import { RgbWaveform } from "./RgbWaveform.js";

export function TrackWaveformPreview({
  trackId,
  className,
}: {
  trackId: string;
  className: string;
}) {
  const query = useQuery({
    queryKey: ["track-waveform", trackId],
    queryFn: ({ signal }) => getTrackWaveform(trackId, signal),
    staleTime: Number.POSITIVE_INFINITY,
  });

  return <RgbWaveform waveform={query.data} className={className} />;
}
