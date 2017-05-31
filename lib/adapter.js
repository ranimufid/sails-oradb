/**
 * Module Dependencies
 */
var oracledb = require('oracledb');
var _ = require('lodash');
var async = require('async');
var Errors = require('waterline-errors').adapter;
var Sequel = require('waterline-sequel');
var utils = require('./utils');
var Processor = require('./processor');
var Cursor = require('waterline-cursor');
var hop = utils.object.hasOwnProperty;
var sql = require('./sql.js');
var SqlString = require('./SqlString');

var LOG_QUERIES = false //process.env.LOG_QUERIES; //It shows all executed queries
var LOG_DEBUG = false //process.env.LOG_DEBUG;  //It show messages which allow you to follow the code
console.log("THE VALUE OF LOG_QUERIES IS: " + LOG_QUERIES);
console.log("THE VALUE OF LOG_DEBUG IS: " + LOG_DEBUG);

module.exports = (function () {


    var sqlOptions = {
        parameterized: true,
        caseSensitive: true,
        escapeCharacter: '"',
        casting: true,
        canReturnValues: true,
        escapeInserts: true,
        declareDeleteAlias: false
    };

    // Connection specific overrides from config
    var connectionOverrides = {};

    // You'll want to maintain a reference to each connection
    // that gets registered with this adapter.
    var connections = {};


    var adapter = {
 

        identity: 'sails-oradb',
        // Which type of primary key is used by default
        pkFormat: 'integer',
        syncable: true,
        // Default configuration for connections
        defaults: {

            schema: true,
            ssl: false

        },
        /** OK
         *
         * This method runs when a model is initially registered
         * at server-start-time.  This is the only required method.
         *
         * @param  {[type]}   connection [description]
         * @param  {[type]}   collection [description]
         * @param  {Function} cb         [description]
         * @return {[type]}              [description]
         */
        registerConnection: function (connection, collections, cb) {
            if (LOG_DEBUG) {
                console.log("SAILS-ORA-ADAPTER: BEGIN registerConnection");
            }
            //BEGIN METODO POR DEFECTO
            if (!connection.identity)
                return cb(new Error('Connection is missing an identity.'));
            if (connections[connection.identity])
                return cb(new Error('Connection is already registered.'));
            //END MÉTODO POR DEFECTO

            var self = this;

            // Store any connection overrides
            connectionOverrides[connection.identity] = {};

            // Look for the WL Next key
            if (hop(connection, 'wlNext')) {
                connectionOverrides[connection.identity].wlNext = _.cloneDeep(connection.wlNext);
            }

            // Build up a schema for this connection that can be used throughout the adapter
            var schema = {};

            _.each(_.keys(collections), function (coll) {
                var collection = collections[coll];
                if (!collection)
                    return;

                var _schema = collection.waterline && collection.waterline.schema && collection.waterline.schema[collection.identity];
                if (!_schema)
                    return;

                // Set defaults to ensure values are set
                if (!_schema.attributes)
                    _schema.attributes = {};
                if (!_schema.tableName)
                    _schema.tableName = coll;

                // If the connection names are't the same we don't need it in the schema
                if (!_.includes(collections[coll].connection, connection.identity)) {
                    return;
                }

                // If the tableName is different from the identity, store the tableName in the schema
                var schemaKey = coll;
                if (_schema.tableName != coll) {
                    schemaKey = _schema.tableName;
                }

                schema[schemaKey] = _schema;
            });
            connection.poolMax = 50; // maximum size of the pool
            connection.poolMin = 0; // let the pool shrink completely
            connection.poolIncrement = 1; // only grow the pool by one connection at a time
            connection.poolTimeout = 0;  // never terminate idle connections
            

            // Create pool
            oracledb.createPool(connection,
                    function (err, p) {
                        if (err) {
                            return handleQueryError(err, 'registerConnection');
                        }

                        // Store the connection
                        connections[connection.identity] = {
                            config: connection,
                            collections: collections,
                            schema: schema,
                            pool: p
                        };
                        

                        // Always call describe
                        // async.eachSeries(Object.keys(collections), function (colName, cb) {
                        //     self.describe(connection.identity, colName, cb);
                        // }, cb);
                        return cb();
                    });

        },
        /** OK
         * Fired when a model is unregistered, typically when the server
         * is killed. Useful for tearing-down remaining open connections,
         * etc.
         *
         * @param  {Function} cb [description]
         * @return {[type]}      [description]
         */
        // Teardown a Connection OK
        teardown: function (conn, cb) {
            if (LOG_DEBUG) {
                console.log("SAILS-ORA-ADAPTER: BEGIN tearDown");
            }
            
            if (typeof conn == 'function') {
                cb = conn;
                conn = null;
            }
            if (!conn) {
                connections = {};
                return cb();
            }
            if (!connections[conn])
                return cb();
            delete connections[conn];
            cb();
        },
        // Raw Query Interface OK
        query: function (connectionName, table, query, data, cb) {
            var connectionObject = connections[connectionName];
            if (LOG_DEBUG) {
                console.log("SAILS-ORA-ADAPTER: BEGIN query");
            }
            
            if (_.isFunction(data)) {
                cb = data;
                data = null;
            }
            
            // Run query
            if (!data)
                data = {};
            connectionObject.pool.getConnection(
                    function (err, connection)
                    {
                        if (err) {
                            return handleQueryError(err, 'query');;
                        }
                        if (LOG_QUERIES) {
                            console.log('SAILS-ORA-ADAPTER: Executing PLAN_SQL query: ' + query);
                        }
                        // console.log("SAILS-ORA-ADAPTER: DATA parameter being sent: " + JSON.stringify(data));
                        connection.execute(query, data, {maxRows:10000, outFormat: oracledb.OBJECT}, function (err, result) {
                            if (err) {
                                doRelease(connection);
                                return cb(err, result);
                            }
                            // console.log("SAILS-ORA-ADAPTER: The query's result is: " + JSON.stringify(result));
                            
                            return castClobs(result, function (err, result) {
                                if (err) {
                                    doRelease(connection);
                                    return cb(err, result);
                                }
                                if (LOG_QUERIES) {
                                    console.log("SAILS-ORA-ADAPTER: Length: " + result.rows.length);
                                    // console.log("SAILS-ORA-ADAPTER: the result of the plain_sql query is: " + JSON.stringify(result.rows));
                                }
                                doRelease(connection);
                                return cb(err, result.rows);
                            });
                        });
                    });
        },
        // Return attributes - OK 
        describe: function (connectionName, table, cb) {
            if (LOG_DEBUG) {
                console.log("SAILS-ORA-ADAPTER: BEGIN describe");
            }
            var connectionObject = connections[connectionName];
            var collection = connectionObject.collections[table];

            if (!collection) {
                return cb(util.format('Unknown collection `%s` in connection `%s`', collectionName, connectionName));
            }

            var queries = [];
            queries[0] = "SELECT COLUMN_NAME, DATA_TYPE, NULLABLE FROM USER_TAB_COLUMNS WHERE TABLE_NAME = '" + table + "'";
            queries[1] = "SELECT index_name,COLUMN_NAME FROM user_ind_columns WHERE table_name = '" + table + "'";
            queries[2] = "SELECT cols.table_name, cols.column_name, cols.position, cons.status, cons.owner "
                    + "FROM all_constraints cons, all_cons_columns cols WHERE cols.table_name = '" + table
                    + "' AND cons.constraint_type = 'P' AND cons.constraint_name = cols.constraint_name AND cons.owner = cols.owner "
                    + "ORDER BY cols.table_name, cols.position";

            
            // Run Query
            connectionObject.pool.getConnection(
                    function (err, connection)
                    {
                        if (err) {
                            handleQueryError(err, 'describe');
                            return;
                        }
                        if (LOG_QUERIES) {
                            console.log('SAILS-ORA-ADAPTER: Executing query: ' + queries[0]);
                        }
                        connection.execute(queries[0], {}, {outFormat: oracledb.OBJECT}, function __SCHEMA__(err, result) {

                            if (err) {
                                /* Release the connection back to the connection pool */
                                doRelease(connection);
                                return cb(handleQueryError(err, 'describe'));
                            }

                            var schema = result.rows;
                            if (LOG_QUERIES) {
                                console.log('SAILS-ORA-ADAPTER: Executing query: ' + queries[1]);
                            }
                            connection.execute(queries[1], {}, {outFormat: oracledb.OBJECT}, function __DEFINE__(err, result) {

                                if (err) {
                                    /* Release the connection back to the connection pool */
                                    doRelease(connection);
                                    return cb(handleQueryError(err, 'describe'));
                                }

                                var indexes = result.rows;

                                if (LOG_QUERIES) {
                                    console.log('SAILS-ORA-ADAPTER: Executing query: ' + queries[2]);
                                }
                                connection.execute(queries[2], {}, {outFormat: oracledb.OBJECT}, function __DEFINE__(err, result) {

                                    if (err) {
                                        /* Release the connection back to the connection pool */
                                        doRelease(connection);
                                        return cb(handleQueryError(err, 'describe'));
                                    }

                                    var tablePrimaryKeys = result.rows;
                                    if (schema.length === 0) {
                                        doRelease(connection);
                                        return cb();
                                    }

                                    // Loop through Schema and attach extra attributes
                                    schema.forEach(function (attribute) {
                                        tablePrimaryKeys.forEach(function (pk) {
                                            // Set Primary Key Attribute
                                            if (attribute.COLUMN_NAME === pk.COLUMN_NAME) {
                                                attribute.primaryKey = true;
                                                // If also a number set auto increment attribute
                                                if (attribute.DATA_TYPE === 'NUMBER') {
                                                    attribute.autoIncrement = true;
                                                }
                                            }
                                        });
                                        // Set Unique Attribute
                                        if (attribute.NULLABLE === 'N') {
                                            attribute.required = true;
                                        }

                                    });
                                    // Loop Through Indexes and Add Properties
                                    indexes.forEach(function (index) {
                                        schema.forEach(function (attribute) {
                                            if (attribute.COLUMN_NAME === index.COLUMN_NAME)
                                            {
                                                attribute.indexed = true;
                                            }
                                        });
                                    });
                                    // Convert mysql format to standard javascript object

                                    //var normalizedSchema = sql.normalizeSchema(schema, collection.attributes);
                                    // Set Internal Schema Mapping
                                    //collection.schema = normalizedSchema;

                                    /* Release the connection back to the connection pool */
                                    doRelease(connection);
                                    // TODO: check that what was returned actually matches the cache
                                    cb(null, schema);

                                });

                            });

                        });
                    });

        },
        /**
         *
         * REQUIRED method if integrating with a schemaful
         * (SQL-ish) database.
         * - OK -
         */
        define: function (connectionName, collectionName, definition, cb) {
            if (LOG_DEBUG) {
                console.log('SAILS-ORA-ADAPTER: BEGIN define');
            }
            
            // Define a new "table" or "collection" schema in the data store
            var self = this;
                
                var connectionObject = connections[connectionName];
                var collectionN = connectionObject.collections[collectionName];
                if (!collectionN) {
                    return cb(util.format('Unknown collection `%s` in connection `%s`', collectionName, connectionName));
                }

                var tableName = collectionName;

                var schema = sql.schema(tableName, definition);

                // Build query
                var query = 'CREATE TABLE "' + tableName + '" (' + schema + ')';

                if (connectionObject.config.charset) {
                    query += ' DEFAULT CHARSET ' + connectionObject.config.charset;
                }

                if (connectionObject.config.collation) {
                    if (!connectionObject.config.charset)
                        query += ' DEFAULT ';
                    query += ' COLLATE ' + connectionObject.config.collation;
                }


                // Run query
                execQuery(connections[connectionName],query, [], function __DEFINE__(err, result) {
                    if (err) {
                        
                        return cb(err);
                    }
                    // creation des sequence pour les champs autoIncrement
                    /*Object.keys(definition).forEach(function(columnName) {
                        var column = definition[columnName];
                        if (fieldIsAutoIncrement(column)) {
                            //init autoIncrement values
                            self.autoIncrements[tableName] = self.autoIncrements[tableName] || [];
                            self.autoIncrements[tableName][columnName] = 1;
                            var autoIncrementQuery = 'SELECT MAX("' + columnName + '") AS MAX FROM "' + tableName + '"';
                            execQuery(connections[connectionName],autoIncrementQuery, [], function(err, autoInc) {
                                if (err) {
                                    if (LOG_ERRORS) {
                                        console.log("could not get last autoIncrement value: ",err);
                                    }
                                    return cb(err);
                                }
                                self.autoIncrements[tableName][columnName] = autoInc[0]['MAX'] || 1;
                            });
                        }
                    });*/
                    //
                    // TODO:
                    // Determine if this can safely be changed to the `adapter` closure var
                    // (i.e. this is the last remaining usage of the "this" context in the MySQLAdapter)
                    //

                    self.describe(connectionName, collectionName, function(err) {
                        cb(err, result);
                    });
                });
        },
        /**
         *
         * REQUIRED method if integrating with a schemaful
         * (SQL-ish) database.
         *
         */

        // Drop a table - OK 
        drop: function (connectionName, table, relations, cb) {
            var connectionObject = connections[connectionName];
            if (LOG_DEBUG) {
                console.log("SAILS-ORA-ADAPTER: BEGIN drop");
            }
            
            if (typeof relations === 'function') {
                cb = relations;
                relations = [];
            }



            // Drop any relations
            function dropTable(item, next) {

                // Build Query
                var query = 'DROP TABLE ' + utils.escapeName(item) + '';

                // Run Query
                
                connectionObject.pool.getConnection(function (err, connection) {
                    if (LOG_QUERIES) {
                        console.log('SAILS-ORA-ADAPTER: Executing query: ' + query);
                    }
                    connection.execute(query, {}, function (err, result) {
                        doRelease(connection);
                        next(null, result);
                    });
                });
                
                
             
                
            }

            async.eachSeries(relations, dropTable, function (err) {
                if (err)
                    return cb(err);
                dropTable(table, cb);
            });



        },
        // Add a column to a table - NO USADO
        addAttribute: function (connectionName, table, attrName, attrDef, cb) {
            var connectionObject = connections[connectionName];
            if (LOG_DEBUG) {
                console.log("BEGIN addAttribute");
            }
            // Escape Table Name
            table = utils.escapeName(table);

            // Setup a Schema Definition
            var attrs = {};
            attrs[attrName] = attrDef;

            var _schema = utils.buildSchema(attrs);

            // Build Query
            var query = 'ALTER TABLE ' + table + ' ADD COLUMN ' + _schema;

            // Run Query
            connectionObject.pool.getConnection(
                    function (err, connection)
                    {
                        if (err) {
                            handleQueryError(err, 'addAttribute');
                            return;
                        }
                        if (LOG_QUERIES) {
                            console.log('SAILS-ORA-ADAPTER: Executing query: ' + query);
                        }
                        connection.execute(query, {}, {outFormat: oracledb.OBJECT}, function __ADD_ATTRIBUTE__(err, result) {
                            /* Release the connection back to the connection pool */
                            doRelease(connection);
                            if (err)
                                return cb(handleQueryError(err, 'addAttribute'));
                            cb(null, result.rows);
                        });
                    });

        },
        // Remove a column from a table - NO USADO
        removeAttribute: function (connectionName, table, attrName, cb) {
            var connectionObject = connections[connectionName];
            if (LOG_DEBUG) {
                console.log("SAILS-ORA-ADAPTER: BEGIN removeAttribute");
            }
            
            // Escape Table Name
            table = utils.escapeName(table);

            // Build Query
            var query = 'ALTER TABLE ' + table + ' DROP COLUMN "' + attrName + '" RESTRICT';

            // Run Query
            connectionObject.pool.getConnection(
                    function (err, connection)
                    {
                        if (err) {
                            handleQueryError(err, 'removeAttribute');
                            return;
                        }
                        if (LOG_QUERIES) {
                            console.log('SAILS-ORA-ADAPTER: Executing query: ' + query);
                        }
                        connection.execute(query, {}, {outFormat: oracledb.OBJECT}, function __REMOVE_ATTRIBUTE__(err, result) {
                            /* Release the connection back to the connection pool */
                            doRelease(connection);
                            if (err)
                                return cb(handleQueryError(err, 'removeAttribute'));
                            cb(null, result.rows);
                        });
                    });

        },
        /**
         *
         * REQUIRED method if users expect to call Model.find(), Model.findOne(),
         * or related.
         *
         * You should implement this method to respond with an array of instances.
         * Waterline core will take care of supporting all the other different
         * find methods/usages.
         *
         */


        // Native Join Support - OK
        join: function (connectionName, table, options, cb) {
            var connectionObject = connections[connectionName];
            if (LOG_DEBUG) {
                console.log("SAILS-ORA-ADAPTER: BEGIN join");
            }
            // Populate associated records for each parent result
            // (or do them all at once as an optimization, if possible)
            Cursor({
                instructions: options,
                nativeJoins: true,
                /**
                 * Find some records directly (using only this adapter)
                 * from the specified collection.
                 *
                 * @param  {String}   collectionIdentity
                 * @param  {Object}   criteria
                 * @param  {Function} _cb
                 */
                $find: function (collectionName, criteria, _cb) {
                    return adapter.find(connectionName, collectionName, criteria, _cb, pool);
                },
                /**
                 * Look up the name of the primary key field
                 * for the collection with the specified identity.
                 *
                 * @param  {String}   collectionIdentity
                 * @return {String}
                 */
                $getPK: function (collectionName) {
                    if (!collectionName)
                        return;
                    return _getPK(connectionName, collectionName);
                },
                /**
                 * Given a strategy type, build up and execute a SQL query for it.
                 *
                 * @param {}
                 */

                $populateBuffers: function populateBuffers(options, next) {

                    var buffers = options.buffers;
                    var instructions = options.instructions;

                    // Grab the collection by looking into the connection
                    var connectionObject = connections[connectionName];
                    var collection = connectionObject.collections[table];

                    var parentRecords = [];
                    var cachedChildren = {};

                    // Grab Connection Schema
                    var schema = {};

                    Object.keys(connectionObject.collections).forEach(function (coll) {
                        schema[coll] = connectionObject.collections[coll].schema;
                    });

                    // Build Query
                    var _schema = connectionObject.schema;

                    // Mixin WL Next connection overrides to sqlOptions
                    var overrides = connectionOverrides[connectionName] || {};
                    var _options = _.cloneDeep(sqlOptions);
                    if (hop(overrides, 'wlNext')) {
                        _options.wlNext = overrides.wlNext;
                    }

                    var sequel = new Sequel(_schema, _options);
                    var _query;

                    // Build a query for the specific query strategy
                    try {
                        _query = sequel.find(table, instructions);
                    } catch (e) {
                        return next(e);
                    }
                    
                    var findQuery = _query.query[0];
                    findQuery = findQuery.split( /\$/g).join(":");
                    findQuery = findQuery.split(" AS ").join(" ");
                                       
                    
                    async.auto({
                        processParent: function (next) {
                            // Run Query
                            connectionObject.pool.getConnection(
                                    function (err, connection)
                                    {
                                        if (err) {
                                            handleQueryError(err, 'join1');
                                            return;
                                        }
                                        if (LOG_QUERIES) {
                                            console.log('SAILS-ORA-ADAPTER: Executing query: ' + findQuery);
                                        }
                                        connection.execute(findQuery, _query.values[0], {outFormat: oracledb.OBJECT}, function __FIND__(err, result) {
                                            /* Release the connection back to the connection pool */
                                            doRelease(connection);
                                            if (err) {
                                                return cb(handleQueryError(err, 'join2'));
                                            }
                                            parentRecords = result.rows;

                                            var splitChildren = function (parent, next) {
                                                var cache = {};

                                                _.keys(parent).forEach(function (key) {

                                                    // Check if we can split this on our special alias identifier '___' and if
                                                    // so put the result in the cache
                                                    var split = key.split('___');
                                                    if (split.length < 2)
                                                        return;

                                                    if (!hop(cache, split[0]))
                                                        cache[split[0]] = {};
                                                    cache[split[0]][split[1]] = parent[key];
                                                    delete parent[key];
                                                });

                                                // Combine the local cache into the cachedChildren
                                                if (_.keys(cache).length > 0) {
                                                    _.keys(cache).forEach(function (pop) {
                                                        if (!hop(cachedChildren, pop))
                                                            cachedChildren[pop] = [];
                                                        cachedChildren[pop] = cachedChildren[pop].concat(cache[pop]);
                                                    });
                                                }

                                                next();
                                            };

                                            // Pull out any aliased child records that have come from a hasFK association
                                            async.eachSeries(parentRecords, splitChildren, function (err) {
                                                if (err)
                                                    return next(err);
                                                buffers.parents = parentRecords;
                                                next();
                                            });

                                        });
                                    });
                        },
                        // Build child buffers.
                        // For each instruction, loop through the parent records and build up a
                        // buffer for the record.
                        buildChildBuffers: ['processParent', function (next, results) {
                                async.each(_.keys(instructions.instructions), function (population, nextPop) {

                                    var populationObject = instructions.instructions[population];
                                    var popInstructions = populationObject.instructions;
                                    var pk = _getPK(connectionName, popInstructions[0].parent);

                                    var alias = populationObject.strategy.strategy === 1 ? popInstructions[0].parentKey : popInstructions[0].alias;

                                    // Use eachSeries here to keep ordering
                                    async.eachSeries(parentRecords, function (parent, nextParent) {
                                        var buffer = {
                                            attrName: population,
                                            parentPK: parent[pk],
                                            pkAttr: pk,
                                            keyName: alias
                                        };

                                        var records = [];

                                        // Check for any cached parent records
                                        if (hop(cachedChildren, alias)) {
                                            cachedChildren[alias].forEach(function (cachedChild) {
                                                var childVal = popInstructions[0].childKey;
                                                var parentVal = popInstructions[0].parentKey;

                                                if (cachedChild[childVal] !== parent[parentVal]) {
                                                    return;
                                                }

                                                // If null value for the parentVal, ignore it
                                                if (parent[parentVal] === null)
                                                    return;

                                                records.push(cachedChild);
                                            });
                                        }

                                        if (records.length > 0) {
                                            buffer.records = records;
                                        }

                                        buffers.add(buffer);
                                        nextParent();
                                    }, nextPop);
                                }, next);
                            }],
                        processChildren: ['buildChildBuffers', function (next, results) {
                                
                                // Remove the parent query
                                _query.query.shift();

                                async.each(_query.query, function (q, next) {

                                    var qs = '';
                                    var pk;

                                    if (!Array.isArray(q.instructions)) {
                                        pk = _getPK(connectionName, q.instructions.parent);
                                    }
                                    else if (q.instructions.length > 1) {
                                        pk = _getPK(connectionName, q.instructions[0].parent);
                                    }

                                    parentRecords.forEach(function (parent) {
                                        if (_.isNumber(parent[pk])) {
                                            qs += q.qs.replace('^?^', parent[pk]) + ' UNION ALL ';
                                        } else {
                                            qs += q.qs.replace('^?^', "'" + parent[pk] + "'") + ' UNION ALL ';
                                        }
                                    });

                                    // Remove the last UNION ALL
                                    qs = qs.slice(0, -11);
                                    // Add a final sort to the Union clause for integration
                                    if (parentRecords.length > 1) {
                                        qs += ' ORDER BY ';

                                        if (!Array.isArray(q.instructions)) {
                                            _.keys(q.instructions.criteria.sort).forEach(function (sortKey) {
                                                var direction = q.instructions.criteria.sort[sortKey] === 1 ? 'ASC' : 'DESC';
                                                qs += '"' + sortKey + '"' + ' ' + direction + ', ';
                                            });
                                        }
                                        else if (q.instructions.length === 2) {
                                            _.keys(q.instructions[1].criteria.sort).forEach(function (sortKey) {
                                                var direction = q.instructions[1].criteria.sort[sortKey] === 1 ? 'ASC' : 'DESC';
                                                qs += '"' + sortKey + '"' + ' ' + direction + ', ';
                                            });
                                        }

                                        // Remove the last comma
                                        qs = qs.slice(0, -2);
                                    }
                                    
                                    connectionObject.pool.getConnection(
                                            function (err, connection)
                                            {
                                                if (err) {
                                                    handleQueryError(err, 'join3');
                                                    return;
                                                }
                                                
                                                qs = qs.split( /\$/g).join(":");;
                                                qs = qs.split(" AS ").join(" ");
                                                qs = qs.split("(").join("");
                                                qs = qs.split(")").join("");
                                                if (LOG_QUERIES) {
                                                    console.log('SAILS-ORA-ADAPTER: Executing query: ' + qs);
                                                }
                                                connection.execute(qs, q.values, {outFormat: oracledb.OBJECT}, function __FIND__(err, result) {
                                                    if (err) {
                                                        return next(handleQueryError(err, 'join4'));
                                                    }

                                                    var groupedRecords = {};

                                                    result.rows.forEach(function (row) {

                                                        if (!Array.isArray(q.instructions)) {

                                                            if (!hop(groupedRecords, row[q.instructions.childKey])) {
                                                                groupedRecords[row[q.instructions.childKey]] = [];
                                                            }

                                                            groupedRecords[row[q.instructions.childKey]].push(row);
                                                        }
                                                        else {

                                                            // Grab the special "foreign key" we attach and make sure to remove it
                                                            var fk = '___' + q.instructions[0].childKey;

                                                            if (!hop(groupedRecords, row[fk])) {
                                                                groupedRecords[row[fk]] = [];
                                                            }

                                                            var data = _.cloneDeep(row);
                                                            delete data[fk];
                                                            groupedRecords[row[fk]].push(data);

                                                            // Ensure we don't have duplicates in here
                                                            groupedRecords[row[fk]] = _.uniq(groupedRecords[row[fk]], q.instructions[1].childKey);
                                                        }
                                                    });

                                                    buffers.store.forEach(function (buffer) {
                                                        if (buffer.attrName !== q.attrName)
                                                            return;
                                                        var records = groupedRecords[buffer.belongsToPKValue];
                                                        if (!records)
                                                            return;
                                                        if (!buffer.records)
                                                            buffer.records = [];
                                                        buffer.records = buffer.records.concat(records);
                                                    });

                                                    next();
                                                });
                                            });
                                }
                                , function (err) {
                                    next();
                                });

                            }]

                    },
                    function (err) {
                        if (err)
                            return next(err);
                        next();
                    });

                }
                
            }, cb);
            if (LOG_DEBUG) {
                console.log("SAILS-ORA-ADAPTER: END JOIN");
            }
            

        },
        // Select Query Logic - OK
        find: function (connectionName, table, options, cb) {
            if (LOG_DEBUG) {
                console.log('SAILS-ORA-ADAPTER: BEGIN find');
            }
            // Grab Connection Schema
            var schema = {};
            var connectionObject = connections[connectionName];
            var collection = connectionObject.collections[table];
            
            Object.keys(connectionObject.collections).forEach(function (coll) {
                schema[coll] = connectionObject.collections[coll].schema;
            });

            // Build Query
            var _schema = connectionObject.schema;
            var processor = new Processor(_schema);

            // Mixin WL Next connection overrides to sqlOptions
            var overrides = connectionOverrides[connectionName] || {};

            var _options = _.cloneDeep(sqlOptions);
            if (hop(overrides, 'wlNext')) {
                _options.wlNext = overrides.wlNext;
            }

            var sequel = new Sequel(_schema, _options);
            var _query;
            
            var limit = options.limit || null;
            var skip = options.skip || null;
            delete options.skip;
            delete options.limit;
            
            // Build a query for the specific query strategy
            delete options.select;
            try {
                _query = sequel.find(table, options);
            } catch (e) {
                return cb(e);
            }
            
            var findQuery = _query.query[0];
            findQuery = findQuery.replace( /\$/g, ':');
            findQuery = findQuery.replace(" AS ", " ");
            
            if (limit && skip) {
                findQuery = 'SELECT * FROM ( select a.*, ROWNUM LINE_NUMBER from (' + findQuery + ') a  where ROWNUM <= '+(skip + limit)+' ) where LINE_NUMBER  > '+skip;
            }
            else if (limit) {
                findQuery = 'SELECT * FROM ( select a.*, ROWNUM LINE_NUMBER from (' + findQuery + ') a  where ROWNUM <= '+limit+' )';
            }
            else if (skip) {
                findQuery = 'SELECT * FROM ( select a.*, ROWNUM LINE_NUMBER from (' + findQuery + ') a  where ROWNUM > ' + skip;
            }
            
            

            // Run Query
            connectionObject.pool.getConnection(
                    function (err, connection)
                    {
                        if (err) {
                            console.log("SAILS-ORA-ADAPTER: ERROR: " + err);
                            doRelease(connection);
                            return cb(handleQueryError(err, 'find'));
                        }
                        if (LOG_QUERIES) {
                            console.log('SAILS-ORA-ADAPTER: Executing query: ' + findQuery);
                        }
                        connection.execute(findQuery, _query.values[0], {outFormat: oracledb.OBJECT}, function __FIND__(err, result) {
                            if (err) {
                                /* Release the connection back to the connection pool */
                                doRelease(connection);
                                return cb(handleQueryError(err, 'find'));
                            }

                            // Cast special values
                            var values = [];

                            result.rows.forEach(function (row) {
                                
                                values.push(processor.cast(table, _.omit(row, 'LINE_NUMBER')));
                            });


                            /* Release the connection back to the connection pool */
                            doRelease(connection);

                            return cb(null, values);

                        });
                    });


            if (LOG_DEBUG) {
                console.log('SAILS-ORA-ADAPTER: END find');
            }
        },
        // Add a new row to the table - OK
        create: function (connectionName, table, data, cb) {
            if (LOG_DEBUG) {
                console.log("OraADAPTER: THE TABLE IS: " + table);
                console.log("OraADAPTER: THE DATA IS: " + JSON.stringify(data));
                console.log("OraADAPTER: BEGIN create");
            }
            
            var connectionObject = connections[connectionName];
            var collection = connectionObject.collections[table];

            var schemaName = collection.meta && collection.meta.schemaName ? utils.escapeName(collection.meta.schemaName) + '.' : '';
            var tableName = schemaName + utils.escapeName(table);

            // Build up a SQL Query
            var schema = connectionObject.schema;
            var processor = new Processor(schema);

            // Mixin WL Next connection overrides to sqlOptions
            var overrides = connectionOverrides[connectionName] || {};
            var options = _.cloneDeep(sqlOptions);
            if (hop(overrides, 'wlNext')) {
                options.wlNext = overrides.wlNext;
            }

            var sequel = new Sequel(schema, options);

            var incrementSequences = [];
            var query;

            Object.keys(schema[table].attributes).forEach(function(column) {
                
                if(schema[table].attributes[column].type === 'datetime'){
                    data[column] = new Date(data[column]);//'to_date('+moment(data[column]).format('YYYY/MM/DD HH:mm:ss')+','+formatDate+')';//moment(data[column]).format('YYYY/MM/DD HH:mm:ss');
                }
            });
            
            // Build a query for the specific query strategy
            try {
                query = sequel.create(table, data);
            } catch (e) {
                return cb(e);
            }

            //ToDo: Now id ALWAYS should be autoIncrement and you cannot set it manually. 
            
            query.query = query.query.replace('RETURNING *', '');
            query.query = query.query.replace( /\$/g, ':');
       
           
            // Run Query
            connectionObject.pool.getConnection(
                    function (err, connection)
                    {
                        if (err) {
                            handleQueryError(err, 'create');
                            return;
                        }
                        if (LOG_QUERIES) {
                            console.log('OraADAPTER: Executing query: ' + query.query);
                            console.log('OraADAPTER: The bind values: ' + JSON.stringify(data));
                        }
                        // var selectQuery = 'select * from "'+table+'" order by "' + _getPK(connectionName, table) +'" desc';
                        //     connection.execute(selectQuery, [],  {maxRows:1, outFormat: oracledb.OBJECT}, function __CREATE_SELECT__(err, result){

                        //         if (err){
                        //             // Release the connection back to the connection pool
                        //             doRelease(connection);
                        //             return cb(handleQueryError(err, 'create_select'));
                        //         }
                        //         // Cast special values
                        //         var values = processor.cast(table, result.rows[0]);
                        //         console.log("The current maximum valus is: " + values);
                        //     }

                        var selectQuery = 'select * from "'+table+'" order by "' + _getPK(connectionName, table) +'" desc';
                        connection.execute("alter session set NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'", [], {maxRows:1, outFormat: oracledb.OBJECT}, function (err, res){
                             // Release the connection back to the connection pool
                                    doRelease(connection);
                        });

                        connection.execute(query.query, _.values(data), {/*outFormat: oracledb.OBJECT, */autoCommit: false}, function __CREATE__(err, result) {

                            if (err) {
                                // Release the connection back to the connection pool
                                doRelease(connection);
                                return cb(handleQueryError(err, 'create'));
                            }
                            var selectQuery = 'select * from "'+table+'" order by "' + _getPK(connectionName, table) +'" desc';
                            connection.execute(selectQuery, [],  {maxRows:1, outFormat: oracledb.OBJECT}, function __CREATE_SELECT__(err, result){

                                if (err){
                                    // Release the connection back to the connection pool
                                    doRelease(connection);
                                    return cb(handleQueryError(err, 'create_select'));
                                }
                                // Cast special values
                                var values = processor.cast(table, result.rows[0]);

                                connection.commit(function (err){

                                    // Release the connection back to the connection pool
                                    doRelease(connection);
                                    if (err){
                                        return cb(handleQueryError(err, 'create_commit')); 
                                    }

                                    cb(null, values);
                                });
                            });
                        });
                    });

        },
        // Add a multiple rows to the table - OK
        /*createEach: function (connectionName, table, valuesList, cb) {
            if (LOG_DEBUG) {
                console.log("BEGIN createEach");
            }
            
            var connectionObject = connections[connectionName];
            var collection = connectionObject.collections[table];
            var tableName = table;
            var records = [];
            var i = 0;

            asynk.each(valuesList, function (data, cb) {

                // Prepare values

                Object.keys(data).forEach(function (value) {
                    data[value] = utils.prepareValue(data[value]);
                });

                var attributes = collection.attributes;
                var definition = collection.definition;
                Object.keys(attributes).forEach(function (attributeName) {
                    var attribute = attributes[attributeName];
                    // searching for column name, if it doesn't exist, we'll use attribute name 
                    var columnName = attribute.columnName || attributeName;
                    // affecting values to add to the columns 
                    data[columnName] = data[attributeName];
                    // deleting attributesto be added and their names are differnet from columns names 
                    if (attributeName !== columnName)
                        delete data[attributeName];
                    // deleting not mapped attributes 
                    if ((_.isUndefined(definition[columnName])) || (_.isUndefined(data[columnName])))
                        delete data[columnName];
                    if (fieldIsDatetime(attribute)) {
                        data[columnName] = (!data[columnName]) ? 'null' : SqlString.dateField(data[columnName]);
                    }
                });

                var schema = collection.waterline.schema;
                var _query;

                var sequel = new Sequel(schema, sqlOptions);


                // Build a query for the specific query strategy
                try {
                    _query = sequel.create(table, data);
                } catch (e) {
                    return cb(e);
                }
                _query.query = _query.query.split( /\$/g).join(":");
                _query.query = _query.query.split(" AS ").join(" ");
                _query.query = _query.query.split(" RETURNING *").join("");
                
                var keys = Object.keys(data);
                
                for(var j=1; j<keys.length+1; j++){
                    _query.query = _query.query.replace(":" + j, ":" + keys[j - 1]);
                }

                //for (key in data) {
                //    if (data.hasOwnProperty(key)) {
                //        var value = data[key]+'';
                //        console.log(value);
                //       if(value.indexOf("TO_TIMESTAMP") > -1){
                //            data[key] = data[key].substring(1, data[key].length-1);
                //        }
                //    }
                //}
                // Run query
                execQuery(connections[connectionName], _query.query, data, function (err, results) {
                    if (err) {
                        return cb(handleQueryError(err));
                    }
                    records.push(results.insertId);
                    i = i+1;
                    cb();
                });
            }).args(asynk.item, asynk.callback).parallel(function (err) {
                if (err)
                    return cb(err);

                var pk = 'id';

                Object.keys(collection.definition).forEach(function (key) {
                    if (!collection.definition[key].hasOwnProperty('primaryKey'))
                        return;
                    pk = key;
                });

                // If there are no records (`!records.length`)
                // then skip the query altogether- we don't need to look anything up
                if (!records.length) {
                    return cb(null, []);
                }

                // Build a Query to get newly inserted records
                //  var query = 'SELECT * FROM ' + tableName.toUpperCase() + ' WHERE ' + pk + ' IN (' + records + ');';
                 
                 // Run Query returing results
                 //connection.execute(query, [], function(err, results) {
                 //if (err)
                 //return cb(err);
                 //cb(null, results);
                 //});
                cb(null, null);
            }, [null]);
        },*/
        // Count Query logic - PENDIENTE
        count: function (connectionName, table, options, cb) {

            if (LOG_DEBUG) {
                console.log("SAILS-ORA-ADAPTER: BEGIN count");
                console.log("SAILS-ORA-ADAPTER: the provided options are: " + JSON.stringify(options));
            }
            
            // Grab Connection Schema
            var schema = {};
            var connectionObject = connections[connectionName];
            var collection = connectionObject.collections[table];

            Object.keys(connectionObject.collections).forEach(function (coll) {
                schema[coll] = connectionObject.collections[coll].schema;
            });

            // Build Query
            var _schema = connectionObject.schema;
            var processor = new Processor(_schema);

            // Mixin WL Next connection overrides to sqlOptions
            var overrides = connectionOverrides[connectionName] || {};
            var _options = _.cloneDeep(sqlOptions);
            if (hop(overrides, 'wlNext')) {
                _options.wlNext = overrides.wlNext;
            }

            var sequel = new Sequel(_schema, _options);
            var _query;

            // Build a query for the specific query strategy
            try {
                _query = sequel.count(table, options);
            } catch (e) {
                return cb(e);
            }

            //iterate throught array elements and update SQL
            var finalQuery=_query.query[0];
            // console.log("My array is this long: " + _query.values[0].length);
            // console.log("My array's first element is: " + _query.values[0][0]);
            for (var i=0; i < _query.values[0].length; i++){
                let j=i + 1;
                finalQuery=finalQuery.replace(("$" + j),("'"+_query.values[0][i] + "'"));
            }
            finalQuery=finalQuery.substring(0, finalQuery.indexOf('AS "'));
            // console.log("The finalQuery is: " + finalQuery);



            // Run Query
            connectionObject.pool.getConnection(
                    function (err, connection)
                    {
                        if (err) {
                            handleQueryError(err, 'count');
                            return;
                        }
                        if (LOG_QUERIES) {
                            console.log('SAILS-ORA-ADAPTER: Executing query: ' + finalQuery);
                        }
                        connection.execute("alter session set NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'", [], {maxRows:1, outFormat: oracledb.OBJECT});
                        connection.execute(finalQuery, [], {outFormat: oracledb.OBJECT}, function __COUNT__(err, result) {
                            if (err) {
                                /* Release the connection back to the connection pool */
                                doRelease(connection);
                                return cb(handleQueryError(err, 'count'));
                            }

                            if (!_.isArray(result.rows) || !result.rows.length) {
                                return cb(new Error('Invalid query, no results returned.'));
                            }
                            var count = result.rows[0] && result.rows[0].count;
                            /* Release the connection back to the connection pool */
                            doRelease(connection);

                            return cb(null, Number(count));

                        });
                    });
        },

        // Update one or more models in the collection - PENDIENTE
        update: function(connectionName, table, options, data, cb) {
            if (LOG_DEBUG) {
                console.log("SAILS-ORA-ADAPTER: BEGIN update");
            }
            //LIMIT in a oracle UPDATE command is not valid
            if (hop(options, 'limit')) {
                return cb(new Error('Your \'LIMIT ' + options.limit + '\' is not allowed in the Oracle DB UPDATE query.'));
            }
            
            var connectionObject = connections[connectionName];
            var collection = connectionObject.collections[table];

            var _schema = connectionObject.schema;
            var processor = new Processor(_schema);

            // Mixin WL Next connection overrides to sqlOptions
            var overrides = connectionOverrides[connectionName] || {};
            var _options = _.cloneDeep(sqlOptions);
            if (hop(overrides, 'wlNext')) {
                _options.wlNext = overrides.wlNext;
            }

            var sequel = new Sequel(_schema, _options);
            var query;
            // Build a query for the specific query strategy
            try {
                query = sequel.update(table, options, data);
            } catch (e) {
                return cb(e);
            }

            query.query = query.query.replace('RETURNING *', '');
            query.query = query.query.replace( /\$/g, ':');
            query.query = query.query.replace(' AS ', " ");
 
            var keys = Object.keys(data);
            var j = 1;
            for (j; j < keys.length + 1; j++) {
                query.query = query.query.replace(":" + j, ":" + keys[j - 1]);
            }
            
            var keysoptions = Object.keys(options.where);
            var oraOptions = {where: {}};
            for(var k=0; k <keysoptions.length; k++){
                oraOptions.where[ "where"+keysoptions[k] ] = options.where[ keysoptions[k] ];
                data["where"+keysoptions[k]] = options.where[ keysoptions[k] ];
            }
            var keysoptions = Object.keys(oraOptions.where);
            for (var z = keys.length; z < keys.length + keysoptions.length + 1; z++) {
                query.query = query.query.replace(":" + z, ":" + keysoptions[z - 1 - keys.length]);
            }
            
            // Run Query
            connectionObject.pool.getConnection(
                    function (err, connection)
                    {
                        if (err) {
                            handleQueryError(err, 'create');
                            return;
                        }
                        if (LOG_QUERIES) {
                            console.log('SAILS-ORA-ADAPTER: Executing query: ' + query.query);
                        }
                        connection.execute(query.query, data, {/*outFormat: oracledb.OBJECT, */autoCommit: false}, function __CREATE__(err, result) {

                            if (err) {
                                // Release the connection back to the connection pool
                                return connection.rollback(function(rollerr) {
                                	doRelease(connection);
                                	return cb(handleQueryError(err, 'update'));
                                });
                            }
                            
                            // Build a query for the specific query strategy
                            try {
                                var _seqQuery = sequel.find(table, options);
                            } catch (e) {
                                return cb(handleQueryError(e, 'update'));
                            }

                            var findQuery = _seqQuery.query[0];
                            findQuery = findQuery.split( /\$/g).join(":");
                            findQuery = findQuery.split(" AS ").join(" ");

                            var keysOptionsSelect = Object.keys(oraOptions.where);
                            for (var z = 1; z < keysOptionsSelect.length + 1; z++) {
                                findQuery = findQuery.replace(":" + z, ":" + keysOptionsSelect[z-1]);
                            }
                            
                            connection.execute(findQuery, oraOptions.where,  {outFormat: oracledb.OBJECT}, function __CREATE_SELECT__(err, result){
                                
                                if (err){
                                    // Release the connection back to the connection pool
                                    return connection.rollback(function(rollerr) {
                                    	doRelease(connection);
                                    	return cb(handleQueryError(err, 'update_select'));
                                    });
                                }

                                // Cast special values
                                var values = [];
                                result.rows.forEach(function (row) {
                                    values.push(processor.cast(table, _.omit(row, 'LINE_NUMBER')));
                                });
                                
                                connection.commit(function (err){
                                    
                                    // Release the connection back to the connection pool
                                    doRelease(connection);
                                    if (err){
                                        return cb(handleQueryError(err, 'update_commit')); 
                                    }
                                    
                                    cb(null, values);
                                });
                            });
                        });
                    });

          

        },
        // Delete one or more models from the collection - PENDIENTE
        destroy: function(connectionName, table, options, cb) {
            if (LOG_DEBUG) {
                console.log("SAILS-ORA-ADAPTER: BEGIN destroy");
            }
            
            var connectionObject = connections[connectionName];
            var collection = connectionObject.collections[table];

            var _schema = connectionObject.schema;

            // Mixin WL Next connection overrides to sqlOptions
            var overrides = connectionOverrides[connectionName] || {};
            var _options = _.cloneDeep(sqlOptions);
            if (hop(overrides, 'wlNext')) {
                _options.wlNext = overrides.wlNext;
            }

            var sequel = new Sequel(_schema, _options);
            var query;

            // Build a query for the specific query strategy
            try {
                query = sequel.destroy(table, options);
            } catch (e) {
                return cb(e);
            }

            query.query = query.query.replace('RETURNING *', '');
            query.query = query.query.replace( /\$/g, ':');
            query.query = query.query.replace(" AS ", " ");
            

            // Run Query
            connectionObject.pool.getConnection(
                    function (err, connection)
                    {
                        if (err) {
                            handleQueryError(err, 'destroy');
                            return;
                        }
                        if (LOG_QUERIES) {
                            console.log('SAILS-ORA-ADAPTER: Executing query: ' + query.query);
                            console.log('SAILS-ORA-ADAPTER: Data for query: ' + JSON.stringify(query.values));
                        }
                        connection.execute(query.query, query.values, {autoCommit: true, outFormat: oracledb.OBJECT}, function __DELETE__(err, result) {
                            if (err) {
                                /* Release the connection back to the connection pool */
                                doRelease(connection);
                                return cb(handleQueryError(err, 'destroy'));
                            }

                            /* Release the connection back to the connection pool */
                            doRelease(connection);

                            cb(null, result.rows);

                        });
                    });

        }


    };

    /*************************************************************************/
    /* Private Methods
     /*************************************************************************/

    /**
     * Lookup the primary key for the given collection
     *
     * @param  {String} connectionName
     * @param  {String} collectionName
     * @return {String}
     * @api private
     */
    function _getPK(connectionName, collectionName) {

        var collectionDefinition;

        try {
            collectionDefinition = connections[connectionName].collections[collectionName].definition;
            var pk;

            pk = _.find(Object.keys(collectionDefinition), function _findPK(key) {
                var attrDef = collectionDefinition[key];
                if (attrDef && attrDef.primaryKey)
                    return key;
                else
                    return false;
            });
            if (LOG_QUERIES) {
                console.log("OraADAPTER: the returned pk is: " + pk);
            }

            if (!pk)
                pk = 'ID';
            return pk;
        }
        catch (e) {
            throw new Error('Unable to determine primary key for collection `' + collectionName + '` because ' +
                    'an error was encountered acquiring the collection definition:\n' + require('util').inspect(e, false, null));
        }
    }


    /**
     *
     * @param  {[type]} err [description]
     * @return {[type]}     [description]
     * @api private
     */
    function handleQueryError(err, func) {
        //TODO: Formatear errores si procede
        console.log("OraADAPTER: " + func);
        return err;
    }

    function doRelease(connection)
    {
        if (connection) {
            connection.release(
                    function (err) {
                        if (err) {
                            return handleQueryError(err.message);
                        }
                    });
        }
        else {
            return handleQueryError("connection not defined");
        }
    }
    
    //check if column or attribute is a boolean
    function fieldIsBoolean(column) {
        return (!_.isUndefined(column.type) && column.type === 'boolean');
    }

    function fieldIsDatetime(column) {
        return (!_.isUndefined(column.type) && column.type === 'datetime');
    }

    function fieldIsAutoIncrement(column) {
        return (!_.isUndefined(column.autoIncrement) && column.autoIncrement);
    }
    
    function dateField (date) {
	return 'TO_DATE(' + date + ',\'yyyy-mm-dd hh24:mi:ss\')';
    }
    
    function execQuery(connection, query, data, cb){
        if (LOG_QUERIES) {
            console.log('OraADAPTER: Executing query: ' + query);
            console.log('OraADAPTER: Data: ' + JSON.stringify(data));
        }
        connection.pool.getConnection(function (err, conn) {
            conn.execute(query, data, {autoCommit: true}, function (err, result) {
                doRelease(conn);
                cb(err, result);
            });
        });
    }

    function castClobs(result, cb) {
        // process all rows in parallel
        async.map(result.rows, function iterator(row, cbRow) {

            // process all columns of row in parallel
            async.forEachOf(row, function(column, key, cbColumn) {

                if (column && column.iLob) {
                    if (LOG_DEBUG) {
                        console.log("OraADAPTER: Found CLOB.");
                    }

                    var lob = oracledb.newLob(column.iLob);
                    var clob = '';
                    if (lob === null || lob.length == 0) {
                        // empty clob
                        row[key] = (lob === null) ? null : '';
                        return cbColumn();
                    }
                    lob.setEncoding('utf8');
                    lob.on('data', function (chunk) {
                        clob += chunk;
                    });
                    lob.on('end', function () {
                        console.log('OraADAPTER: Completed write ' + clob.length);
                    });
                    lob.on('close', function () {
                        row[key] = clob; // change clob to its content value
                        return cbColumn();
                    });
                    lob.on('error', function (err) {
                        return cbColumn(err);
                    });
                } else {
                    // clob column not found, nothing to do
                    return cbColumn();
                }
            }, function(err, newRow) {
                if (err) {
                    return cbRow(err);
                }
                return cbRow(null, row);
            })
        },
        function (err, newRows) {
            if (err) {
                return cb(err);
            }
            result.rows = newRows;
            return cb(null, result);
        });
    }
    
    // Expose adapter definition
    return adapter;

})();

