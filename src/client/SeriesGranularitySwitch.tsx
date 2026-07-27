import { Segmented, Space, Typography } from 'antd';

export type SeriesGranularity = 'five_min' | 'hour' | 'day';

export const SERIES_GRANULARITY_LABEL: Record<SeriesGranularity, string> = {
  five_min: '5 分钟',
  hour: '小时',
  day: '天',
};

interface SeriesGranularitySwitchProps {
  value: SeriesGranularity;
  onChange: (value: SeriesGranularity) => void;
}

export function SeriesGranularitySwitch({ value, onChange }: SeriesGranularitySwitchProps) {
  return (
    <Space size="small">
      <Typography.Text type="secondary">粒度</Typography.Text>
      <Segmented
        size="small"
        value={value}
        options={[
          { label: '5 分钟', value: 'five_min' },
          { label: '小时', value: 'hour' },
          { label: '天', value: 'day' },
        ]}
        onChange={(next) => onChange(next as SeriesGranularity)}
      />
    </Space>
  );
}

export function formatSeriesBucketLabel(bucket: string, granularity: SeriesGranularity): string {
  if (!bucket) return '';
  const utcDate = new Date(`${bucket}:00.000Z`);
  if (Number.isNaN(utcDate.getTime())) return bucket;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const day = `${pad(utcDate.getMonth() + 1)}-${pad(utcDate.getDate())}`;
  if (granularity === 'day') return day;
  return `${day} ${pad(utcDate.getHours())}:${pad(utcDate.getMinutes())}`;
}

/**
 * 趋势图默认 dataZoom 起点。
 * 统一从 0 开始：与顶部时间窗口一致（选「今天」即自然日 00:00 ~ now），
 * 不再截成「最近 N 桶」。需要细看局部时用户可拖底部 slider。
 */
export function defaultSeriesZoomStart(_length: number, _granularity: SeriesGranularity): number {
  return 0;
}
