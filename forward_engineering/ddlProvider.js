const defaultTypes = require('./configs/defaultTypes');
const types = require('./configs/types');
const templates = require('./configs/templates');

const getPartitioningByIngestionTime = (partitioningType) => {
	const type = {
		'By day': 'DAY',
		'By hour': 'HOUR',
		'By month': 'MONTH',
		'By year': 'YEAR',
	}[partitioningType] || 'DAY';

	return `TIMESTAMP_TRUNC(_PARTITIONTIME, ${type})`;
};

const getPartitioningByIntegerRange = (rangeOptions = {}) => {
	const name = rangeOptions.rangePartitionKey?.[0]?.name;
	const start = Number(rangeOptions.rangeStart);
	const end = Number(rangeOptions.rangeEnd);
	const interval = Number(rangeOptions.rangeinterval);

	return `RANGE_BUCKET(${name}, GENERATE_ARRAY(${start}, ${end}${isNaN(interval) ? '' : `, ${interval}`}))`;
};

const getTablePartitioning = ({
	partitioning,
	partitioningType,
	timeUnitPartitionKey,
	rangeOptions,
}) => {
	if (partitioning === 'No partitioning') {
		return '';
	}

	if (partitioning === 'By ingestion time') {
		return '\nPARTITION BY ' + getPartitioningByIngestionTime(partitioningType);
	}

	if (partitioning === 'By time-unit column') {
		return `\nPARTITION BY DATE(${timeUnitPartitionKey?.[0].name})`;
	}

	if (partitioning === 'By integer-range') {
		return '\nPARTITION BY ' + getPartitioningByIntegerRange(rangeOptions[0]);
	}

	return '';
};

const getTableOptions = (tab, getLabels) => ({
	expiration,
	partitioningFilterRequired,
	partitioning,
	customerEncryptionKey,
	description,
	labels,
	friendlyName,
}) => {
	const options = [];

	if (friendlyName) {
		options.push(`friendly_name="${friendlyName}"`);
	}

	if (description) {
		options.push(`description="${description}"`);
	}

	if (expiration) {
		options.push(`expiration_timestamp=TIMESTAMP "${getTimestamp(expiration)}"`);
	}

	if (partitioning === 'By ingestion time' && partitioningFilterRequired) {
		options.push(`require_partition_filter=true`);
	}

	if (customerEncryptionKey) {
		options.push(`kms_key_name="${customerEncryptionKey}"`);
	}

	if (Array.isArray(labels) && labels.length) {
		options.push(`labels=[\n${tab(getLabels(labels))}\n]`);
	}

	if (!options.length) {
		return '';
	}

	return `\nOPTIONS (\n${
		tab(options.join(',\n'))
	}\n)`;
};

const getTimestamp = (unixTs) => {
	const fill = (n) => (n + '').padStart(2, '0');
	
	const date = new Date(Number(unixTs));

	const day = fill(date.getUTCDate());
	const month = fill(date.getUTCMonth() + 1);
	const year = date.getUTCFullYear();
	const hours = fill(date.getUTCHours());
	const minutes = fill(date.getUTCMinutes());
	const seconds = fill(date.getUTCSeconds());

	return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC`
};

const convertItemsToType = (deps) => (items) => {
	if (!Array.isArray(items)) {
		items = [items];
	}

	return items.map(item => {
		return getColumnSchema(deps)({
			type: item.type,
			description: item.description,
			dataTypeMode: item.dataTypeMode,
			jsonSchema: item,
		}, true);
	});
};

const convertPropertiesToType = (deps) => (properties) => {
	return Object.keys(properties).map(name => {
		const item = properties[name];

		return getColumnSchema(deps)({
			name,
			type: item.type,
			description: item.description,
			dataTypeMode: item.dataTypeMode,
			jsonSchema: item,
		});
	});
};

const addParameters = (jsonSchema) => {
	const params = [];

	if (jsonSchema.precision) {
		params.push(jsonSchema.precision);
	}

	if (jsonSchema.scale) {
		params.push(jsonSchema.scale);
	}

	if (jsonSchema.length) {
		params.push(jsonSchema.length);
	}

	if (params.length) {
		return `(${params.join(', ')})`;
	}

	return '';
};

const getColumnSchema = (deps) => ({ type, description, dataTypeMode, name, jsonSchema }, isArrayItem) => {
	const { assignTemplates, tab } = deps;
	let dataType = type;
	let options = '';
	let notNull = '';

	if (type === 'array') {
		dataType = ` ARRAY<\n${
			tab(
				convertItemsToType(deps)(jsonSchema.items).join(',\n')
			)
		}\n>`;
	} else if (dataTypeMode === 'Repeated') {
		const {dataTypeMode, ...item} = jsonSchema; 

		dataType = getColumnSchema(deps)({
			type: 'array',
			description,
			jsonSchema: {
				items: [item],
			},
		});
	} else if (type === 'struct') {
		dataType = ` STRUCT<\n${
			tab(
				convertPropertiesToType(deps)(jsonSchema.properties).join(',\n'),
			)
		}\n>`;
	} else {
		dataType = (' ' + type).toUpperCase() + addParameters(jsonSchema);
	}

	if (description) {
		options += ` OPTIONS( description="${description}" )`;
	}

	if (dataTypeMode === 'Required' && !isArrayItem) {
		notNull = ' NOT NULL';
	}

	return assignTemplates(templates.columnDefinition, {
		type: dataType,
		options,
		notNull,
		name,
	});
};

module.exports = (baseProvider, options, app) => {
	const {
		tab,
		commentIfDeactivated,
		checkAllKeysDeactivated,
		divideIntoActivatedAndDeactivated,
		hasType,
		wrap,
		clean,
	} = app.utils.general;
	const assignTemplates = app.utils.assignTemplates;
	const _ = app.require('lodash');
	const { getLabels, getFullName } = require('./helpers/general')(_);

	return {
		createDatabase({
			databaseName,
			friendlyName,
			description,
			ifNotExist,
			projectId,
			defaultExpiration,
			customerEncryptionKey,
			labels,
		}) {
			let dbOptions = [];

			if (friendlyName) {
				dbOptions.push(`friendly_name="${friendlyName}"`);
			}

			if (description) {
				dbOptions.push(`description="${description}"`);
			}

			if (customerEncryptionKey) {
				dbOptions.push(`default_kms_key_name="${customerEncryptionKey}"`);
			}

			if (defaultExpiration) {
				dbOptions.push(`default_table_expiration_days=${defaultExpiration}`);
			}

			if (labels.length) {
				dbOptions.push(`labels=[\n${
					tab(
						getLabels(labels)
					)}\n]`);
			}

			const databaseStatement = assignTemplates(templates.createDatabase, {
				name: getFullName(projectId, databaseName),
				ifNotExist: ifNotExist ? ' IF NOT EXISTS' : '',
				dbOptions: dbOptions.length ? `OPTIONS(\n${tab(dbOptions.join(',\n'))}\n)` : '',
			});

			return databaseStatement;
		},

		createTable(
			{
				name,
				columns,
				dbData,
				description,
				orReplace,
				ifNotExist,
				partitioning,
				partitioningType,
				timeUnitPartitionKey,
				partitioningFilterRequired,
				rangeOptions,
				temporary,
				expiration,
				tableType,
				clusteringKey,
				customerEncryptionKey,
				labels,
				friendlyName,
			},
			isActivated,
		) {
			const tableName = getFullName(dbData.projectId, dbData.databaseName, name);
			const orReplaceTable = orReplace ? 'OR REPLACE ' : '';
			const temporaryTable = temporary ? 'TEMPORARY ' : '';
			const ifNotExistTable = ifNotExist ? 'IF NOT EXISTS ' : '';
			const partitions = getTablePartitioning({
				partitioning,
				partitioningType,
				timeUnitPartitionKey,
				rangeOptions,
			});
			const clustering = Array.isArray(clusteringKey) && clusteringKey.length ? '\nCLUSTER BY ' + clusteringKey.map(key => key.name).join(', ') : '';
			const options = getTableOptions(tab, getLabels)({
				partitioningFilterRequired,
				customerEncryptionKey,
				partitioning,
				friendlyName,
				description,
				expiration,
				labels,
			});
			const external = tableType === 'External' ? 'EXTERNAL ' : '';

			const tableStatement = assignTemplates(templates.createTable, {
				name: tableName,
				column_definitions: tab(columns.join(',\n')),
				orReplace: orReplaceTable,
				temporary: temporaryTable,
				ifNotExist: ifNotExistTable,
				partitions,
				clustering,
				external,
				options,
			});

			return tableStatement;
		},

		convertColumnDefinition(columnDefinition) {
			return getColumnSchema({ assignTemplates, tab })(columnDefinition);
		},

		createView(viewData, dbData, isActivated) {
			// const allDeactivated = checkAllKeysDeactivated(viewData.keys || []);
			// const deactivatedWholeStatement = allDeactivated || !isActivated;
			// const { columns, tables } = getViewData(viewData.keys, dbData);
			// let columnsAsString = columns.map(column => column.statement).join(',\n\t\t');

			// if (!deactivatedWholeStatement) {
			// 	const dividedColumns = divideIntoActivatedAndDeactivated(columns, column => column.statement);
			// 	const deactivatedColumnsString = dividedColumns.deactivatedItems.length
			// 		? commentIfDeactivated(dividedColumns.deactivatedItems.join(',\n\t\t'), {
			// 				isActivated: false,
			// 				isPartOfLine: true,
			// 		  })
			// 		: '';
			// 	columnsAsString = dividedColumns.activatedItems.join(',\n\t\t') + deactivatedColumnsString;
			// }

			// const selectStatement = _.trim(viewData.selectStatement)
			// 	? _.trim(tab(viewData.selectStatement))
			// 	: assignTemplates(templates.viewSelectStatement, {
			// 			tableName: tables.join(', '),
			// 			keys: columnsAsString,
			// 	  });

			// const algorithm = viewData.algorithm && viewData.algorithm !== 'UNDEFINED' ? `ALGORITHM ${viewData.algorithm} ` : '';

			// return commentIfDeactivated(
			// 	assignTemplates(templates.createView, {
			// 		name: getTableName(viewData.name, dbData.databaseName),
			// 		orReplace: viewData.orReplace ? 'OR REPLACE ' : '',
			// 		ifNotExist: viewData.ifNotExist ? 'IF NOT EXISTS ' : '',
			// 		sqlSecurity: viewData.sqlSecurity ? `SQL SECURITY ${viewData.sqlSecurity} ` : '',
			// 		checkOption: viewData.checkOption ? `\nWITH ${viewData.checkOption} CHECK OPTION` : '',
			// 		selectStatement,
			// 		algorithm,
			// 	}),
			// 	{ isActivated: !deactivatedWholeStatement },
			// );

			return '';
		},

		getDefaultType(type) {
			return defaultTypes[type];
		},

		getTypesDescriptors() {
			return types;
		},

		hasType(type) {
			return hasType(types, type);
		},

		hydrateColumn({ columnDefinition, jsonSchema, dbData }) {
			return {
				name: columnDefinition.name,
				type: columnDefinition.type,
				description: jsonSchema.description,
				dataTypeMode: jsonSchema.dataTypeMode,
				jsonSchema,
			};
		},


		hydrateDatabase(containerData, data) {
			const modelData = data?.modelData;

			return {
				databaseName: containerData.name,
				friendlyName: containerData.businessBucketName,
				description: containerData.description,
				isActivated: containerData.isActivated,
				ifNotExist: containerData.ifNotExist,
				projectId: modelData?.[0]?.projectID,
				defaultExpiration: containerData.enableTableExpiration ? containerData.defaultExpiration : '',
				customerEncryptionKey: containerData.encryption === 'Customer-managed' ? containerData.customerEncryptionKey : '',
				labels: Array.isArray(containerData.labels) ? containerData.labels : [],
			};
		},

		hydrateTable({ tableData, entityData, jsonSchema }) {
			const data = entityData[0];

			return {
				...tableData,
				name: data.collectionName,
				friendlyName: jsonSchema.title && jsonSchema.title !== data.collectionName ? jsonSchema.title : '',
				description: data.description,
				orReplace: data.orReplace,
				ifNotExist: data.ifNotExist,
				partitioning: data.partitioning,
				partitioningType: data.partitioningType,
				timeUnitPartitionKey: data.timeUnitpartitionKey,
				partitioningFilterRequired: data.partitioningFilterRequired,
				rangeOptions: data.rangeOptions,
				temporary: data.temporary,
				expiration: data.expiration,
				tableType: data.tableType,
				clusteringKey: data.clusteringKey,
				clusteringOrder: data.clusteringOrder,
				customerEncryptionKey: data.encryption ? data.customerEncryptionKey : '',
				labels: data.labels,
			};
		},

		hydrateViewColumn(data) {
			return {
				name: data.name,
				tableName: data.entityName,
				alias: data.alias,
			};
		},

		hydrateView({ viewData, entityData, relatedSchemas, relatedContainers }) {
			const detailsTab = entityData[0];

			return {
				name: viewData.name,
				tableName: viewData.tableName,
				keys: viewData.keys,
				orReplace: detailsTab.orReplace,
				ifNotExist: detailsTab.ifNotExist,
			};
		},

		commentIfDeactivated(statement, data, isPartOfLine) {
			return statement;
		},
	};
};
