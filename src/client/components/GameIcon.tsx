import { useEffect, useState } from 'react';

const DEFAULT_GAME_ICON = '/game-icons/default.svg';

export function gameIconSrc(gameKey: string): string {
  return `/game-icons/${gameKey}.png`;
}

export function GameIcon({
  gameKey,
  name,
  className = 'home-game-icon',
}: {
  gameKey: string;
  name: string;
  className?: string;
}) {
  const [src, setSrc] = useState(gameIconSrc(gameKey));

  useEffect(() => {
    setSrc(gameIconSrc(gameKey));
  }, [gameKey]);

  return (
    <img
      className={className}
      src={src}
      alt=""
      title={name}
      onError={() => {
        if (src !== DEFAULT_GAME_ICON) setSrc(DEFAULT_GAME_ICON);
      }}
    />
  );
}
