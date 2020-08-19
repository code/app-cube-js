import {
  groupBy, pipe, fromPairs, uniq, filter, map, unnest, dropLast, equals, reduce, minBy, maxBy, clone, mergeDeepLeft
} from 'ramda';
import Moment from 'moment';
import momentRange from 'moment-range';

const moment = momentRange.extendMoment(Moment);

const TIME_SERIES = {
  day: (range) => Array.from(range.by('day'))
    .map(d => d.format('YYYY-MM-DDT00:00:00.000')),
  month: (range) => Array.from(range.snapTo('month').by('month'))
    .map(d => d.format('YYYY-MM-01T00:00:00.000')),
  year: (range) => Array.from(range.snapTo('year').by('year'))
    .map(d => d.format('YYYY-01-01T00:00:00.000')),
  hour: (range) => Array.from(range.by('hour'))
    .map(d => d.format('YYYY-MM-DDTHH:00:00.000')),
  minute: (range) => Array.from(range.by('minute'))
    .map(d => d.format('YYYY-MM-DDTHH:mm:00.000')),
  second: (range) => Array.from(range.by('second'))
    .map(d => d.format('YYYY-MM-DDTHH:mm:ss.000')),
  week: (range) => Array.from(range.snapTo('isoweek').by('week'))
    .map(d => d.startOf('isoweek').format('YYYY-MM-DDT00:00:00.000'))
};

const DateRegex = /^\d\d\d\d-\d\d-\d\d$/;
const LocalDateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z?$/;

const groupByToPairs = (keyFn) => {
  const acc = new Map();
  
  return (data) => {
    data.forEach((row) => {
      const key = keyFn(row);
      
      if (!acc.has(key)) {
        acc.set(key, []);
      }
  
      acc.get(key).push(row);
    });
    
    return Array.from(acc.entries());
  };
};

class ResultSet {
  constructor(loadResponse, options = {}) {
    this.loadResponse = loadResponse;
    this.loadResponses = Array.isArray(loadResponse) ? loadResponse : [loadResponse];
    this.parseDateMeasures = options.parseDateMeasures;
    this.options = options;
    
    this.backwardCompatibleData = [];
  }
  
  drillDown(drillDownLocator, pivotConfig) {
    if (this.loadResponses.length > 1) {
      throw new Error('compareDateRange drillDown query is not currently supported');
    }
    
    const { xValues = [], yValues = [] } = drillDownLocator;
    const normalizedPivotConfig = this.normalizePivotConfig(pivotConfig);

    const values = [];
    normalizedPivotConfig.x.forEach((member, currentIndex) => values.push([member, xValues[currentIndex]]));
    normalizedPivotConfig.y.forEach((member, currentIndex) => values.push([member, yValues[currentIndex]]));

    const { measures } = this.loadResponse.annotation;
    let [, measureName] = values.find(([member]) => member === 'measues') || [];

    if (measureName === undefined) {
      [measureName] = Object.keys(measures);
    }

    if (!(measures[measureName] && measures[measureName].drillMembers || []).length) {
      return null;
    }

    const filters = [{
      member: measureName,
      operator: 'measureFilter',
    }];
    const timeDimensions = [];

    values.filter(([member]) => member !== 'measures')
      .forEach(([member, value]) => {
        const [cubeName, dimension, granularity] = member.split('.');

        if (granularity !== undefined) {
          const range = moment.range(value, value).snapTo(
            granularity
          );

          timeDimensions.push({
            dimension: [cubeName, dimension].join('.'),
            dateRange: [
              range.start,
              range.end
            ].map((dt) => dt.format(moment.HTML5_FMT.DATETIME_LOCAL_MS)),
          });
        } else {
          filters.push({
            member,
            operator: 'equals',
            values: [value.toString()],
          });
        }
      });

    return {
      ...measures[measureName].drillMembersGrouped,
      filters,
      timeDimensions,
      timezone: this.loadResponse.query.timezone
    };
  }

  series(pivotConfig) {
    return this.seriesNames(pivotConfig).map(({ title, key }) => ({
      title,
      key,
      series: this.chartPivot(pivotConfig).map(({ category, x, ...obj }) => ({ value: obj[key], category, x }))
    }));
  }

  axisValues(axis) {
    const [{ query }] = this.loadResponses;
    return row => {
      const value = (measure) => axis.filter(d => !['measures'].includes(d))
        .map(d => (row[d] != null ? row[d] : null)).concat(measure ? [measure] : []);
      if (axis.find(d => d === 'measures') && (query.measures || []).length) {
        return query.measures.map(value);
      }
      return [value()];
    };
  }

  axisValuesString(axisValues, delimiter) {
    const formatValue = (v) => {
      if (v == null) {
        return '∅';
      } else if (v === '') {
        return '[Empty string]';
      } else {
        return v;
      }
    };
    return axisValues.map(formatValue).join(delimiter || ', ');
  }

  static timeDimensionMember(td) {
    return `${td.dimension}.${td.granularity}`;
  }

  static getNormalizedPivotConfig(query, pivotConfig = null) {
    const defaultPivotConfig = {
      x: [],
      y: [],
      fillMissingDates: true,
      joinDateRange: false
    };
    
    let isCompareDateRangeQuery = false;
    if ((Array.isArray(query) && query.length > 1)) {
      isCompareDateRangeQuery = true;
    }
    query = Array.isArray(query) ? query[0] : query;
    if ((query.timeDimensions || []).some(({ compareDateRange }) => Boolean(compareDateRange))) {
      isCompareDateRangeQuery = true;
    }

    const timeDimensions = (query.timeDimensions || []).filter(td => !!td.granularity);
    const dimensions = query.dimensions || [];
    
    pivotConfig = pivotConfig || (timeDimensions.length ? {
      x: timeDimensions.map(td => ResultSet.timeDimensionMember(td)),
      y: dimensions
    } : {
      x: dimensions,
      y: []
    });
    
    pivotConfig = mergeDeepLeft(pivotConfig, defaultPivotConfig);

    const substituteTimeDimensionMembers = axis => axis.map(
      subDim => (
        (
          timeDimensions.find(td => td.dimension === subDim) &&
          !dimensions.find(d => d === subDim)
        ) ?
          ResultSet.timeDimensionMember(query.timeDimensions.find(td => td.dimension === subDim)) :
          subDim
      )
    );

    pivotConfig.x = substituteTimeDimensionMembers(pivotConfig.x);
    pivotConfig.y = substituteTimeDimensionMembers(pivotConfig.y);

    const allIncludedDimensions = pivotConfig.x.concat(pivotConfig.y);
    const allDimensions = timeDimensions.map(td => ResultSet.timeDimensionMember(td)).concat(dimensions);
    
    const dimensionFilter = (key) => ['measures', 'compareDateRange'].includes(key)
      || (key !== 'measures' && allDimensions.includes(key));
    
    pivotConfig.x = pivotConfig.x.concat(
      allDimensions.filter(d => !allIncludedDimensions.includes(d))
    ).filter(dimensionFilter);
    pivotConfig.y = pivotConfig.y.filter(dimensionFilter);
    
    if (!pivotConfig.x.concat(pivotConfig.y).find(d => d === 'measures')) {
      pivotConfig.y.push('measures');
    }
    if (!(query.measures || []).length) {
      pivotConfig.x = pivotConfig.x.filter(d => d !== 'measures');
      pivotConfig.y = pivotConfig.y.filter(d => d !== 'measures');
    }
    if (isCompareDateRangeQuery && !allIncludedDimensions.find((d) => d === 'compareDateRange')) {
      pivotConfig.y = ['compareDateRange'].concat(pivotConfig.y);
    }
    
    return pivotConfig;
  }
  
  normalizePivotConfig(pivotConfig) {
    return ResultSet.getNormalizedPivotConfig(this.loadResponses.map(({ query }) => query), pivotConfig);
  }

  static measureFromAxis(axisValues) {
    return axisValues[axisValues.length - 1];
  }

  timeSeries(timeDimension) {
    if (!timeDimension.granularity) {
      return null;
    }
    let { dateRange } = timeDimension;
    if (!dateRange) {
      const dates = pipe(
        map(
          row => row[ResultSet.timeDimensionMember(timeDimension)] &&
            moment(row[ResultSet.timeDimensionMember(timeDimension)])
        ),
        filter(r => !!r)
      )(this.timeDimensionBackwardCompatibleData());

      dateRange = dates.length && [
        reduce(minBy(d => d.toDate()), dates[0], dates),
        reduce(maxBy(d => d.toDate()), dates[0], dates)
      ] || null;
    }

    if (!dateRange) {
      return null;
    }

    const padToDay = timeDimension.dateRange ?
      timeDimension.dateRange.find(d => d.match(DateRegex)) :
      !['hour', 'minute', 'second'].includes(timeDimension.granularity);

    const [start, end] = dateRange;
    const range = moment.range(start, end);

    if (!TIME_SERIES[timeDimension.granularity]) {
      throw new Error(`Unsupported time granularity: ${timeDimension.granularity}`);
    }

    return TIME_SERIES[timeDimension.granularity](
      padToDay ? range.snapTo('day') : range
    );
  }

  pivot(pivotConfig) {
    pivotConfig = this.normalizePivotConfig(pivotConfig);
    
    const pivotImpl = (responseIndex = 0) => {
      let groupByXAxis = groupByToPairs(({ xValues }) => this.axisValuesString(xValues));
      
      let measureValue = (row, measure) => row[measure];
      const { query } = this.loadResponses[responseIndex];
  
      if (
        pivotConfig.fillMissingDates &&
        pivotConfig.x.length === 1 &&
        equals(
          pivotConfig.x,
          (query.timeDimensions || [])
            .filter(td => !!td.granularity)
            .map(td => ResultSet.timeDimensionMember(td))
        )
      ) {
        const series = this.loadResponses.map(
          (loadResponse) => this.timeSeries(loadResponse.query.timeDimensions[0])
        );
        
        if (series[0]) {
          groupByXAxis = (rows) => {
            const byXValues = groupBy(
              ({ xValues }) => moment(xValues[0]).format(moment.HTML5_FMT.DATETIME_LOCAL_MS),
              rows
            );
            return series[responseIndex].map(d => [d, byXValues[d] || [{ xValues: [d], row: {} }]]);
          };
  
          measureValue = (row, measure) => row[measure] || 0;
        }
      }
  
      const xGrouped = pipe(
        map(row => this.axisValues(pivotConfig.x)(row).map(xValues => ({ xValues, row }))),
        unnest,
        groupByXAxis
      )(this.timeDimensionBackwardCompatibleData(responseIndex));
  
      const allYValues = pipe(
        map(
          ([, rows]) => unnest(
            // collect Y values only from filled rows
            rows.filter(({ row }) => Object.keys(row).length > 0).map(({ row }) => this.axisValues(pivotConfig.y)(row))
          )
        ),
        unnest,
        uniq
      )(xGrouped);
      
      return xGrouped.map(([, rows]) => {
        const { xValues } = rows[0];
        const yGrouped = pipe(
          map(({ row }) => this.axisValues(pivotConfig.y)(row).map(yValues => ({ yValues, row }))),
          unnest,
          groupBy(({ yValues }) => this.axisValuesString(yValues))
        )(rows);
        
        return {
          xValues,
          yValuesArray: unnest(allYValues.map(yValues => {
            const measure = pivotConfig.x.find(d => d === 'measures') ?
              ResultSet.measureFromAxis(xValues) :
              ResultSet.measureFromAxis(yValues);
              
            return (yGrouped[this.axisValuesString(yValues)] ||
              [{ row: {} }]).map(({ row }) => [yValues, measureValue(row, measure)]);
          }))
        };
      });
    };
    
    const pivots = this.loadResponses.length > 1
      ? this.loadResponses.map((_, index) => pivotImpl(index))
      : [];
    
    return pivots.length
      ? this.mergePivots(pivots, pivotConfig.joinDateRange)
      : pivotImpl();
  }
  
  mergePivots(pivots, joinDateRange) {
    const minLengthPivot = pivots.reduce(
      (memo, current) => (memo != null && current.length >= memo.length ? memo : current), null
    );
    
    return minLengthPivot.map((_, index) => {
      const xValues = joinDateRange
        ? [pivots.map((pivot) => pivot[index] && pivot[index].xValues || []).join(', ')]
        : minLengthPivot[index].xValues;
  
      return {
        xValues,
        yValuesArray: unnest(pivots.map((pivot) => pivot[index].yValuesArray))
      };
    });
  }
  
  pivotedRows(pivotConfig) { // TODO
    return this.chartPivot(pivotConfig);
  }

  chartPivot(pivotConfig) {
    const validate = (value) => {
      if (this.parseDateMeasures && LocalDateRegex.test(value)) {
        return new Date(value);
      } else if (!Number.isNaN(Number.parseFloat(value))) {
        return Number.parseFloat(value);
      }

      return value;
    };
    
    return this.pivot(pivotConfig).map(({ xValues, yValuesArray }) => ({
      category: this.axisValuesString(xValues, ','), // TODO deprecated
      x: this.axisValuesString(xValues, ','),
      xValues,
      ...(
        yValuesArray
          .map(([yValues, m]) => ({
            [this.axisValuesString(yValues, ',')]: m && validate(m),
          }))
          .reduce((a, b) => Object.assign(a, b), {})
      )
    }));
  }

  tablePivot(pivotConfig) {
    const normalizedPivotConfig = this.normalizePivotConfig(pivotConfig || {});
    const isMeasuresPresent = normalizedPivotConfig.x.concat(normalizedPivotConfig.y).includes('measures');
    
    return this.pivot(normalizedPivotConfig).map(({ xValues, yValuesArray }) => fromPairs(
      normalizedPivotConfig.x
        .map((key, index) => [key, xValues[index]])
        .concat(
          isMeasuresPresent ? yValuesArray.map(([yValues, measure]) => [
            yValues.length ? yValues.join() : 'value',
            measure
          ]) : []
        )
    ));
  }

  tableColumns(pivotConfig) {
    const normalizedPivotConfig = this.normalizePivotConfig(pivotConfig || {});
    const [{ annotation }] = this.loadResponses;
    const flatMeta = Object.values(annotation).reduce((a, b) => ({ ...a, ...b }), {});
    const schema = {};
    
    const extractFields = (key) => {
      const { title, shortTitle, type, format, meta } = flatMeta[key] || {};
  
      return {
        key,
        title,
        shortTitle,
        type,
        format,
        meta
      };
    };
    
    const pivot = this.pivot(normalizedPivotConfig);
    
    (pivot[0] && pivot[0].yValuesArray || []).forEach(([yValues]) => {
      if (yValues.length > 0) {
        let currentItem = schema;
    
        yValues.forEach((value, index) => {
          currentItem[value] = {
            key: value,
            memberId: normalizedPivotConfig.y[index] === 'measures'
              ? value
              : normalizedPivotConfig.y[index],
            children: (currentItem[value] && currentItem[value].children) || {}
          };
    
          currentItem = currentItem[value].children;
        });
      }
    });
    
    const toColumns = (item = {}, path = []) => {
      if (Object.keys(item).length === 0) {
        return [];
      }
  
      return Object.values(item).map(({ key, ...currentItem }) => {
        const children = toColumns(currentItem.children, [
          ...path,
          key
        ]);

        const { title, shortTitle, ...fields } = extractFields(currentItem.memberId);
        
        const dimensionValue = key !== currentItem.memberId || title == null ? key : '';
        
        if (!children.length) {
          return {
            ...fields,
            key,
            dataIndex: [...path, key].join(),
            title: [title, dimensionValue].join(' ').trim(),
            shortTitle: dimensionValue || shortTitle,
          };
        }
  
        return {
          ...fields,
          key,
          title: [title, dimensionValue].join(' ').trim(),
          shortTitle: dimensionValue || shortTitle,
          children,
        };
      });
    };
    
    let otherColumns = [];
    
    if (!pivot.length && normalizedPivotConfig.y.includes('measures')) {
      otherColumns = (this.loadResponses[0].query.measures || []).map(
        (key) => ({ ...extractFields(key), dataIndex: key })
      );
    }
    
    // Syntatic column to display the measure value
    if (!normalizedPivotConfig.y.length && normalizedPivotConfig.x.includes('measures')) {
      otherColumns.push({
        key: 'value',
        dataIndex: 'value',
        title: 'Value',
        shortTitle: 'Value',
        type: 'string',
      });
    }
    
    return normalizedPivotConfig.x
      .map((key) => {
        if (key === 'measures') {
          return {
            key: 'measures',
            dataIndex: 'measures',
            title: 'Measures',
            shortTitle: 'Measures',
            type: 'string',
          };
        }

        return ({ ...extractFields(key), dataIndex: key });
      })
      .concat(toColumns(schema))
      .concat(otherColumns);
  }

  totalRow() {
    return this.chartPivot()[0];
  }

  categories(pivotConfig) { // TODO
    return this.chartPivot(pivotConfig);
  }

  seriesNames(pivotConfig) {
    pivotConfig = this.normalizePivotConfig(pivotConfig);
    const [{ annotation }] = this.loadResponses;
    
    const seriesNames = unnest(this.loadResponses.map((_, index) => pipe(
      map(this.axisValues(pivotConfig.y)),
      unnest,
      uniq
    )(
      this.timeDimensionBackwardCompatibleData(index)
    )));

    return seriesNames.map(axisValues => ({
      title: this.axisValuesString(
        pivotConfig.y.find(d => d === 'measures') ?
          dropLast(1, axisValues).concat(
            annotation.measures[
              ResultSet.measureFromAxis(axisValues)
            ].title
          ) :
          axisValues, ', '
      ),
      key: this.axisValuesString(axisValues, ','),
      yValues: axisValues
    }));
  }

  query() {
    if (this.loadResponses.length > 1) {
      throw new Error('Method is not supported for a comparison query. Please use decompose');
    }
    
    return this.loadResponse.query;
  }

  rawData() {
    if (this.loadResponses.length > 1) {
      throw new Error('Method is not supported for a comparison query. Please use decompose');
    }
    
    return this.loadResponse.data;
  }
  
  annotation() {
    if (this.loadResponses.length > 1) {
      throw new Error('Method is not supported for a comparison query. Please use decompose');
    }
    
    return this.loadResponse.annotation;
  }

  timeDimensionBackwardCompatibleData(responseIndex = 0) {
    if (!this.backwardCompatibleData[responseIndex]) {
      const { data, query } = this.loadResponses[responseIndex];
      const timeDimensions = (query.timeDimensions || []).filter(td => !!td.granularity);
      const [td] = query.timeDimensions || [];
        
      this.backwardCompatibleData[responseIndex] = data.map(row => (
        {
          ...row,
          ...(
            fromPairs(Object.keys(row)
              .filter(
                field => timeDimensions.find(d => d.dimension === field) &&
                  !row[ResultSet.timeDimensionMember(timeDimensions.find(d => d.dimension === field))]
              ).map(field => (
                [ResultSet.timeDimensionMember(timeDimensions.find(d => d.dimension === field)), row[field]]
              )))
          ),
          compareDateRange: td && (td.dateRange || []).join(' - ')
        }
      ));
    }
    
    return this.backwardCompatibleData[responseIndex];
  }
  
  decompose() {
    return this.loadResponses.map((loadResponse) => new ResultSet(loadResponse, this.options));
  }
  
  serialize() {
    return {
      loadResponse: clone(this.loadResponse)
    };
  }
  
  static deserialize(data, options = {}) {
    return new ResultSet(data.loadResponse, options);
  }
}

export default ResultSet;
