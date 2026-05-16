import { useMemo, useState } from 'react';
import { Alert, Card, Collapse, DatePicker, Space, Typography, message } from 'antd';
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

/**
 * 商业化分析页：把“用户值多少钱（LTV）”和“买用户花多少钱（ROI）”放在同一个经营决策流里。
 *
 * 页面顺序按经营动作设计：
 * 1. 先看是否盈利、明天投多少、是否加投/降预算；
 * 2. 再补录真实投放和微信收入；
 * 3. 最后展开 LTV/商业化能力，解释为什么能赚或亏。
 */
export function CommercialPage() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>(defaultCommercialRange);
  const ltvWindow = useMemo(() => rangeToWindow(range), [range]);

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="商业化分析 · ROI 决策 + LTV 回收"
        description={
          <Space orientation="vertical" size={0}>
            <Text>
              这个页面合并“ROI 录入”和“商业化 LTV”：先回答能不能赚钱、明天投多少，再用 LTV/ARPDAU/广告漏斗解释回收能力。
            </Text>
            <Text type="secondary">
              ROI 以你录入的真实投放花费和微信真实收入为准；LTV 优先使用真实 eCPM，缺少真实收入/曝光时回退预估 eCPM，用于趋势和早期回收判断。
            </Text>
          </Space>
        }
      />

      <Card title="商业化时间范围">
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
            只影响本页 ROI 明细、LTV、ARPDAU 和广告漏斗；不使用顶部大盘时间窗口。默认近 30 天，不含今天。
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
