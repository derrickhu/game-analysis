import { useMemo, useState } from 'react';
import { Card, Collapse, DatePicker, Space, Typography, message } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';

import type { WindowValue } from '../timeWindow';
import { LtvPage } from './LtvPage';
import { RoiPage } from './RoiPage';

const { Text } = Typography;
const { RangePicker } = DatePicker;

function defaultCommercialRange(): [Dayjs, Dayjs] {
  const yesterday = dayjs().subtract(1, 'day');
  return [yesterday.subtract(29, 'day'), yesterday];
}

function rangeToWindow(range: [Dayjs, Dayjs]): WindowValue {
  return {
    kind: 'range',
    fromTs: range[0].startOf('day').valueOf(),
    toTs: range[1].endOf('day').valueOf(),
  };
}

/** 商业化分析页：默认只展示经营决策，LTV 细节作为底部解释层。 */
export function CommercialPage() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>(defaultCommercialRange);
  const ltvWindow = useMemo(() => rangeToWindow(range), [range]);

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <Card title="商业化决策范围">
        <Space wrap>
          <RangePicker
            allowClear={false}
            value={range}
            format="YYYY-MM-DD"
            disabledDate={(date) => !date || date.isSame(dayjs(), 'day') || date.isAfter(dayjs(), 'day')}
            onChange={(value) => {
              if (!value || !value[0] || !value[1]) return;
              const days = value[1].startOf('day').diff(value[0].startOf('day'), 'day') + 1;
              if (days > 60) {
                message.warning('商业化分析一次最多看 60 天，避免 cohort 曲线过密');
                return;
              }
              setRange([value[0], value[1]] as [Dayjs, Dayjs]);
            }}
            presets={[
              { label: '近 7 天', value: [dayjs().subtract(7, 'day'), dayjs().subtract(1, 'day')] as [Dayjs, Dayjs] },
              { label: '近 14 天', value: [dayjs().subtract(14, 'day'), dayjs().subtract(1, 'day')] as [Dayjs, Dayjs] },
              { label: '近 30 天', value: defaultCommercialRange() },
            ]}
          />
          <Text type="secondary">
            默认近 30 天，不含今天；页面顶部优先给出是否继续投放、预算和止损建议。
          </Text>
        </Space>
      </Card>

      <RoiPage displayRange={range} />

      <Collapse
        defaultActiveKey={['ltv']}
        items={[
          {
            key: 'ltv',
            label: 'LTV 与商业化能力（ARPDAU / 广告漏斗 / Cohort 回收）',
            children: <LtvPage windowOverride={ltvWindow} />,
          },
        ]}
      />
    </Space>
  );
}
