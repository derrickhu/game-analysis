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

export function defaultSeriesZoomStart(length: number, granularity: SeriesGranularity): number {
  const visible = granularity === 'five_min' ? 60 : granularity === 'hour' ? 96 : 60;
  return length > visible ? Math.max(0, 100 - (visible / length) * 100) : 0;
}
