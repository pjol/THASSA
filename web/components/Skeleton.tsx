// Shimmer skeletons for every async surface.

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

export function PostCardSkeleton() {
  return (
    <div className="card mb-4 overflow-hidden" aria-hidden>
      <div className="flex items-center gap-3 px-4 py-3">
        <Skeleton className="h-9 w-9 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-2.5 w-16" />
        </div>
      </div>
      <Skeleton className="aspect-square w-full rounded-none" />
      <div className="space-y-2 px-4 py-3">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-3 w-3/4" />
      </div>
    </div>
  );
}

export function StoriesRailSkeleton() {
  return (
    <div className="mb-4 flex gap-4 overflow-hidden px-1 py-2" aria-hidden>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex flex-col items-center gap-1.5">
          <Skeleton className="h-16 w-16 rounded-full" />
          <Skeleton className="h-2 w-12" />
        </div>
      ))}
    </div>
  );
}

export function RowSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-1 py-1.5">
          <Skeleton className="h-11 w-11 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function GridSkeleton({ cells = 12 }: { cells?: number }) {
  return (
    <div className="grid grid-cols-3 gap-1" aria-hidden>
      {Array.from({ length: cells }).map((_, i) => (
        <Skeleton key={i} className="aspect-square rounded-none" />
      ))}
    </div>
  );
}
