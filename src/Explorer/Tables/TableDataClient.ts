import * as ko from "knockout";
import Q from "q";

import { displayTokenRenewalPromptForStatus, getAuthorizationHeader } from "../../Utils/AuthorizationUtils";
import { AuthType } from "../../AuthType";
import { ConsoleDataType } from "../../Explorer/Menus/NotificationConsole/NotificationConsoleComponent";
import { FeedOptions } from "@azure/cosmos";
import * as Constants from "../../Common/Constants";
import * as Entities from "./Entities";
import * as HeadersUtility from "../../Common/HeadersUtility";
import * as NotificationConsoleUtils from "../../Utils/NotificationConsoleUtils";
import * as TableConstants from "./Constants";
import * as TableEntityProcessor from "./TableEntityProcessor";
import * as ViewModels from "../../Contracts/ViewModels";
import Explorer from "../Explorer";
import { configContext } from "../../ConfigContext";
import { handleError } from "../../Common/ErrorHandlingUtils";
import { createDocument } from "../../Common/dataAccess/createDocument";
import { deleteDocument } from "../../Common/dataAccess/deleteDocument";
import { queryDocuments } from "../../Common/dataAccess/queryDocuments";
import { updateDocument } from "../../Common/dataAccess/updateDocument";

export interface CassandraTableKeys {
  partitionKeys: CassandraTableKey[];
  clusteringKeys: CassandraTableKey[];
}

export interface CassandraTableKey {
  property: string;
  type: string;
}

export abstract class TableDataClient {
  constructor() {}

  public abstract createDocument(
    collection: ViewModels.Collection,
    entity: Entities.ITableEntity
  ): Q.Promise<Entities.ITableEntity>;

  public abstract updateDocument(
    collection: ViewModels.Collection,
    originalDocument: any,
    newEntity: Entities.ITableEntity
  ): Promise<Entities.ITableEntity>;

  public abstract queryDocuments(
    collection: ViewModels.Collection,
    query: string,
    shouldNotify?: boolean,
    paginationToken?: string
  ): Promise<Entities.IListTableEntitiesResult>;

  public abstract deleteDocuments(
    collection: ViewModels.Collection,
    entitiesToDelete: Entities.ITableEntity[]
  ): Promise<any>;
}

export class TablesAPIDataClient extends TableDataClient {
  public createDocument(
    collection: ViewModels.Collection,
    entity: Entities.ITableEntity
  ): Q.Promise<Entities.ITableEntity> {
    const deferred = Q.defer<Entities.ITableEntity>();
    createDocument(
      collection,
      TableEntityProcessor.convertEntityToNewDocument(<Entities.ITableEntityForTablesAPI>entity)
    ).then(
      (newDocument: any) => {
        const newEntity = TableEntityProcessor.convertDocumentsToEntities([newDocument])[0];
        deferred.resolve(newEntity);
      },
      reason => {
        deferred.reject(reason);
      }
    );
    return deferred.promise;
  }

  public async updateDocument(
    collection: ViewModels.Collection,
    originalDocument: any,
    entity: Entities.ITableEntity
  ): Promise<Entities.ITableEntity> {
    try {
      const newDocument = await updateDocument(
        collection,
        originalDocument,
        TableEntityProcessor.convertEntityToNewDocument(<Entities.ITableEntityForTablesAPI>entity)
      );
      return TableEntityProcessor.convertDocumentsToEntities([newDocument])[0];
    } catch (error) {
      handleError(error, "TablesAPIDataClient/updateDocument");
      throw error;
    }
  }

  public async queryDocuments(
    collection: ViewModels.Collection,
    query: string
  ): Promise<Entities.IListTableEntitiesResult> {
    try {
      const options = {
        enableCrossPartitionQuery: HeadersUtility.shouldEnableCrossPartitionKey()
      } as FeedOptions;
      const iterator = queryDocuments(collection.databaseId, collection.id(), query, options);
      const response = await iterator.fetchNext();
      const documents = response?.resources;
      const entities = TableEntityProcessor.convertDocumentsToEntities(documents);

      return {
        Results: entities,
        ContinuationToken: iterator.hasMoreResults(),
        iterator: iterator
      };
    } catch (error) {
      handleError(error, "TablesAPIDataClient/queryDocuments", "Query documents failed");
      throw error;
    }
  }

  public async deleteDocuments(
    collection: ViewModels.Collection,
    entitiesToDelete: Entities.ITableEntity[]
  ): Promise<any> {
    const documentsToDelete: any[] = TableEntityProcessor.convertEntitiesToDocuments(
      <Entities.ITableEntityForTablesAPI[]>entitiesToDelete,
      collection
    );

    await Promise.all(
      documentsToDelete?.map(async document => {
        document.id = ko.observable<string>(document.id);
        await deleteDocument(collection, document);
      })
    );
  }
}

export class CassandraAPIDataClient extends TableDataClient {
  public createDocument(
    collection: ViewModels.Collection,
    entity: Entities.ITableEntity
  ): Q.Promise<Entities.ITableEntity> {
    const notificationId = NotificationConsoleUtils.logConsoleMessage(
      ConsoleDataType.InProgress,
      `Adding new row to table ${collection.id()}`
    );
    let properties = "(";
    let values = "(";
    for (let property in entity) {
      if (entity[property]._ === null) {
        continue;
      }
      properties = properties.concat(`${property}, `);
      const propertyType = entity[property].$;
      if (this.isStringType(propertyType)) {
        values = values.concat(`'${entity[property]._}', `);
      } else {
        values = values.concat(`${entity[property]._}, `);
      }
    }
    properties = properties.slice(0, properties.length - 2) + ")";
    values = values.slice(0, values.length - 2) + ")";
    const query = `INSERT INTO ${collection.databaseId}.${collection.id()} ${properties} VALUES ${values}`;
    const deferred = Q.defer<Entities.ITableEntity>();
    this.queryDocuments(collection, query)
      .then(
        (data: any) => {
          entity[TableConstants.EntityKeyNames.RowKey] = entity[this.getCassandraPartitionKeyProperty(collection)];
          entity[TableConstants.EntityKeyNames.RowKey]._ = entity[TableConstants.EntityKeyNames.RowKey]._.toString();
          NotificationConsoleUtils.logConsoleInfo(`Successfully added new row to table ${collection.id()}`);
          deferred.resolve(entity);
        },
        error => {
          handleError(error, "AddRowCassandra", `Error while adding new row to table ${collection.id()}`);
          deferred.reject(error);
        }
      )
      .finally(() => {
        NotificationConsoleUtils.clearInProgressMessageWithId(notificationId);
      });
    return deferred.promise;
  }

  public async updateDocument(
    collection: ViewModels.Collection,
    originalDocument: any,
    newEntity: Entities.ITableEntity
  ): Promise<Entities.ITableEntity> {
    const clearMessage = NotificationConsoleUtils.logConsoleProgress(`Updating row ${originalDocument.RowKey._}`);

    try {
      let whereSegment = " WHERE";
      let keys: CassandraTableKey[] = collection.cassandraKeys.partitionKeys.concat(
        collection.cassandraKeys.clusteringKeys
      );
      for (let keyIndex in keys) {
        const key = keys[keyIndex].property;
        const keyType = keys[keyIndex].type;
        whereSegment += this.isStringType(keyType)
          ? ` ${key} = '${newEntity[key]._}' AND`
          : ` ${key} = ${newEntity[key]._} AND`;
      }
      whereSegment = whereSegment.slice(0, whereSegment.length - 4);

      let updateQuery = `UPDATE ${collection.databaseId}.${collection.id()}`;
      let isPropertyUpdated = false;
      for (let property in newEntity) {
        if (
          !originalDocument[property] ||
          newEntity[property]._.toString() !== originalDocument[property]._.toString()
        ) {
          updateQuery += this.isStringType(newEntity[property].$)
            ? ` SET ${property} = '${newEntity[property]._}',`
            : ` SET ${property} = ${newEntity[property]._},`;
          isPropertyUpdated = true;
        }
      }

      if (isPropertyUpdated) {
        updateQuery = updateQuery.slice(0, updateQuery.length - 1);
        updateQuery += whereSegment;
        await this.queryDocuments(collection, updateQuery);
      }

      let deleteQuery = `DELETE `;
      let isPropertyDeleted = false;
      for (let property in originalDocument) {
        if (property !== TableConstants.EntityKeyNames.RowKey && !newEntity[property] && !!originalDocument[property]) {
          deleteQuery += ` ${property},`;
          isPropertyDeleted = true;
        }
      }

      if (isPropertyDeleted) {
        deleteQuery = deleteQuery.slice(0, deleteQuery.length - 1);
        deleteQuery += ` FROM ${collection.databaseId}.${collection.id()}${whereSegment}`;
        await this.queryDocuments(collection, deleteQuery);
      }

      newEntity[TableConstants.EntityKeyNames.RowKey] = originalDocument[TableConstants.EntityKeyNames.RowKey];
      NotificationConsoleUtils.logConsoleInfo(`Successfully updated row ${newEntity.RowKey._}`);
      return newEntity;
    } catch (error) {
      handleError(error, "UpdateRowCassandra", "Failed to update row ${newEntity.RowKey._}");
      throw error;
    } finally {
      clearMessage();
    }
  }

  public async queryDocuments(
    collection: ViewModels.Collection,
    query: string,
    shouldNotify?: boolean,
    paginationToken?: string
  ): Promise<Entities.IListTableEntitiesResult> {
    const clearMessage =
      shouldNotify && NotificationConsoleUtils.logConsoleProgress(`Querying rows for table ${collection.id()}`);
    try {
      const authType = window.authType;
      const apiEndpoint: string =
        authType === AuthType.EncryptedToken
          ? Constants.CassandraBackend.guestQueryApi
          : Constants.CassandraBackend.queryApi;
      const authorizationHeader = getAuthorizationHeader();

      const response = await fetch(`${configContext.BACKEND_ENDPOINT}/${apiEndpoint}`, {
        method: "POST",
        body: JSON.stringify({
          accountName:
            collection && collection.container.databaseAccount && collection.container.databaseAccount().name,
          cassandraEndpoint: this.trimCassandraEndpoint(
            collection.container.databaseAccount().properties.cassandraEndpoint
          ),
          resourceId: collection.container.databaseAccount().id,
          keyspaceId: collection.databaseId,
          tableId: collection.id(),
          query,
          paginationToken
        }),
        headers: {
          [authorizationHeader.header]: authorizationHeader.token,
          [Constants.HttpHeaders.contentType]: "application/json"
        }
      });

      if (!response.ok) {
        displayTokenRenewalPromptForStatus(response.status);
        throw Error(`Failed to query rows for table ${collection.id()}`);
      }

      const data = await response.json();
      shouldNotify &&
        NotificationConsoleUtils.logConsoleInfo(
          `Successfully fetched ${data.result.length} rows for table ${collection.id()}`
        );
      return {
        Results: data.result,
        ContinuationToken: data.paginationToken
      };
    } catch (error) {
      shouldNotify &&
        handleError(error, "QueryDocumentsCassandra", `Failed to query rows for table ${collection.id()}`);
      throw error;
    } finally {
      clearMessage?.();
    }
  }

  public async deleteDocuments(
    collection: ViewModels.Collection,
    entitiesToDelete: Entities.ITableEntity[]
  ): Promise<any> {
    const query = `DELETE FROM ${collection.databaseId}.${collection.id()} WHERE `;
    const partitionKeyProperty = this.getCassandraPartitionKeyProperty(collection);

    await Promise.all(
      entitiesToDelete.map(async (currEntityToDelete: Entities.ITableEntity) => {
        const clearMessage = NotificationConsoleUtils.logConsoleProgress(`Deleting row ${currEntityToDelete.RowKey._}`);
        const partitionKeyValue = currEntityToDelete[partitionKeyProperty];
        const currQuery =
          query + this.isStringType(partitionKeyValue.$)
            ? `${partitionKeyProperty} = '${partitionKeyValue._}'`
            : `${partitionKeyProperty} = ${partitionKeyValue._}`;

        try {
          await this.queryDocuments(collection, currQuery);
          NotificationConsoleUtils.logConsoleInfo(`Successfully deleted row ${currEntityToDelete.RowKey._}`);
        } catch (error) {
          handleError(error, "DeleteRowCassandra", `Error while deleting row ${currEntityToDelete.RowKey._}`);
          throw error;
        } finally {
          clearMessage();
        }
      })
    );
  }

  public createKeyspace(
    cassandraEndpoint: string,
    resourceId: string,
    explorer: Explorer,
    createKeyspaceQuery: string
  ): Q.Promise<any> {
    if (!createKeyspaceQuery) {
      return Q.reject("No query specified");
    }

    const deferred: Q.Deferred<any> = Q.defer();
    const notificationId = NotificationConsoleUtils.logConsoleMessage(
      ConsoleDataType.InProgress,
      `Creating a new keyspace with query ${createKeyspaceQuery}`
    );
    this.createOrDeleteQuery(cassandraEndpoint, resourceId, createKeyspaceQuery, explorer)
      .then(
        (data: any) => {
          NotificationConsoleUtils.logConsoleMessage(
            ConsoleDataType.Info,
            `Successfully created a keyspace with query ${createKeyspaceQuery}`
          );
          deferred.resolve();
        },
        error => {
          handleError(
            error,
            "CreateKeyspaceCassandra",
            `Error while creating a keyspace with query ${createKeyspaceQuery}`
          );
          deferred.reject(error);
        }
      )
      .finally(() => {
        NotificationConsoleUtils.clearInProgressMessageWithId(notificationId);
      });

    return deferred.promise.timeout(Constants.ClientDefaults.requestTimeoutMs);
  }

  public createTableAndKeyspace(
    cassandraEndpoint: string,
    resourceId: string,
    explorer: Explorer,
    createTableQuery: string,
    createKeyspaceQuery?: string
  ): Q.Promise<any> {
    let createKeyspacePromise: Q.Promise<any>;
    if (createKeyspaceQuery) {
      createKeyspacePromise = this.createKeyspace(cassandraEndpoint, resourceId, explorer, createKeyspaceQuery);
    } else {
      createKeyspacePromise = Q.resolve(null);
    }

    const deferred = Q.defer();
    createKeyspacePromise.then(
      () => {
        const notificationId = NotificationConsoleUtils.logConsoleMessage(
          ConsoleDataType.InProgress,
          `Creating a new table with query ${createTableQuery}`
        );
        this.createOrDeleteQuery(cassandraEndpoint, resourceId, createTableQuery, explorer)
          .then(
            (data: any) => {
              NotificationConsoleUtils.logConsoleMessage(
                ConsoleDataType.Info,
                `Successfully created a table with query ${createTableQuery}`
              );
              deferred.resolve();
            },
            error => {
              handleError(error, "CreateTableCassandra", `Error while creating a table with query ${createTableQuery}`);
              deferred.reject(error);
            }
          )
          .finally(() => {
            NotificationConsoleUtils.clearInProgressMessageWithId(notificationId);
          });
      },
      reason => {
        deferred.reject(reason);
      }
    );
    return deferred.promise;
  }

  public deleteTableOrKeyspace(
    cassandraEndpoint: string,
    resourceId: string,
    deleteQuery: string,
    explorer: Explorer
  ): Q.Promise<any> {
    const deferred = Q.defer<any>();
    const notificationId = NotificationConsoleUtils.logConsoleMessage(
      ConsoleDataType.InProgress,
      `Deleting resource with query ${deleteQuery}`
    );
    this.createOrDeleteQuery(cassandraEndpoint, resourceId, deleteQuery, explorer)
      .then(
        () => {
          NotificationConsoleUtils.logConsoleMessage(
            ConsoleDataType.Info,
            `Successfully deleted resource with query ${deleteQuery}`
          );
          deferred.resolve();
        },
        error => {
          handleError(
            error,
            "DeleteKeyspaceOrTableCassandra",
            `Error while deleting resource with query ${deleteQuery}`
          );
          deferred.reject(error);
        }
      )
      .finally(() => {
        NotificationConsoleUtils.clearInProgressMessageWithId(notificationId);
      });
    return deferred.promise;
  }

  public async getTableKeys(collection: ViewModels.Collection): Promise<CassandraTableKeys> {
    if (!!collection.cassandraKeys) {
      return collection.cassandraKeys;
    }
    const notificationId = NotificationConsoleUtils.logConsoleMessage(
      ConsoleDataType.InProgress,
      `Fetching keys for table ${collection.id()}`
    );
    const authType = window.authType;
    const apiEndpoint: string =
      authType === AuthType.EncryptedToken
        ? Constants.CassandraBackend.guestKeysApi
        : Constants.CassandraBackend.keysApi;
    let endpoint = `${configContext.BACKEND_ENDPOINT}/${apiEndpoint}`;
    const authorizationHeader = getAuthorizationHeader();

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body: JSON.stringify({
          accountName:
            collection && collection.container.databaseAccount && collection.container.databaseAccount().name,
          cassandraEndpoint: this.trimCassandraEndpoint(
            collection.container.databaseAccount().properties.cassandraEndpoint
          ),
          resourceId: collection.container.databaseAccount().id,
          keyspaceId: collection.databaseId,
          tableId: collection.id()
        }),
        headers: {
          [authorizationHeader.header]: authorizationHeader.token,
          [Constants.HttpHeaders.contentType]: "application/json"
        }
      });

      if (!response.ok) {
        displayTokenRenewalPromptForStatus(response.status);
        throw Error(`Fetching keys for table ${collection.id()} failed`);
      }

      const data: CassandraTableKeys = await response.json();
      collection.cassandraKeys = data;
      NotificationConsoleUtils.logConsoleMessage(
        ConsoleDataType.Info,
        `Successfully fetched keys for table ${collection.id()}`
      );

      return data;
    } catch (error) {
      handleError(error, "FetchKeysCassandra", `Error fetching keys for table ${collection.id()}`);
      throw error;
    } finally {
      NotificationConsoleUtils.clearInProgressMessageWithId(notificationId);
    }
  }

  public async getTableSchema(collection: ViewModels.Collection): Promise<CassandraTableKey[]> {
    if (!!collection.cassandraSchema) {
      return collection.cassandraSchema;
    }
    const notificationId = NotificationConsoleUtils.logConsoleMessage(
      ConsoleDataType.InProgress,
      `Fetching schema for table ${collection.id()}`
    );
    const authType = window.authType;
    const apiEndpoint: string =
      authType === AuthType.EncryptedToken
        ? Constants.CassandraBackend.guestSchemaApi
        : Constants.CassandraBackend.schemaApi;
    let endpoint = `${configContext.BACKEND_ENDPOINT}/${apiEndpoint}`;
    const authorizationHeader = getAuthorizationHeader();

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body: JSON.stringify({
          accountName:
            collection && collection.container.databaseAccount && collection.container.databaseAccount().name,
          cassandraEndpoint: this.trimCassandraEndpoint(
            collection.container.databaseAccount().properties.cassandraEndpoint
          ),
          resourceId: collection.container.databaseAccount().id,
          keyspaceId: collection.databaseId,
          tableId: collection.id()
        }),
        headers: {
          [authorizationHeader.header]: authorizationHeader.token,
          [Constants.HttpHeaders.contentType]: "application/json"
        }
      });

      if (!response.ok) {
        displayTokenRenewalPromptForStatus(response.status);
        throw Error(`Failed to fetch schema for table ${collection.id()}`);
      }

      const data = await response.json();
      collection.cassandraSchema = data.columns;
      NotificationConsoleUtils.logConsoleMessage(
        ConsoleDataType.Info,
        `Successfully fetched schema for table ${collection.id()}`
      );

      return data.columns;
    } catch (error) {
      handleError(error, "FetchSchemaCassandra", `Error fetching schema for table ${collection.id()}`);
      throw error;
    } finally {
      NotificationConsoleUtils.clearInProgressMessageWithId(notificationId);
    }
  }

  private async createOrDeleteQuery(
    cassandraEndpoint: string,
    resourceId: string,
    query: string,
    explorer: Explorer
  ): Promise<void> {
    const authType = window.authType;
    const apiEndpoint: string =
      authType === AuthType.EncryptedToken
        ? Constants.CassandraBackend.guestCreateOrDeleteApi
        : Constants.CassandraBackend.createOrDeleteApi;
    const authorizationHeader = getAuthorizationHeader();

    const response = await fetch(`${configContext.BACKEND_ENDPOINT}/${apiEndpoint}`, {
      method: "POST",
      body: JSON.stringify({
        accountName: explorer.databaseAccount() && explorer.databaseAccount().name,
        cassandraEndpoint: this.trimCassandraEndpoint(cassandraEndpoint),
        resourceId,
        query
      }),
      headers: {
        [authorizationHeader.header]: authorizationHeader.token,
        [Constants.HttpHeaders.contentType]: "application/json"
      }
    });

    if (!response.ok) {
      displayTokenRenewalPromptForStatus(response.status);
      throw Error(`Failed to create or delete keyspace/table`);
    }
  }

  private trimCassandraEndpoint(cassandraEndpoint: string): string {
    if (!cassandraEndpoint) {
      return cassandraEndpoint;
    }

    if (cassandraEndpoint.indexOf("https://") === 0) {
      cassandraEndpoint = cassandraEndpoint.slice(8, cassandraEndpoint.length);
    }

    if (cassandraEndpoint.indexOf(":443/", cassandraEndpoint.length - 5) !== -1) {
      cassandraEndpoint = cassandraEndpoint.slice(0, cassandraEndpoint.length - 5);
    }

    return cassandraEndpoint;
  }

  private isStringType(dataType: string): boolean {
    // TODO figure out rest of types that are considered strings by Cassandra (if any have been missed)
    return (
      dataType === TableConstants.CassandraType.Text ||
      dataType === TableConstants.CassandraType.Inet ||
      dataType === TableConstants.CassandraType.Ascii ||
      dataType === TableConstants.CassandraType.Varchar
    );
  }

  private getCassandraPartitionKeyProperty(collection: ViewModels.Collection): string {
    return collection.cassandraKeys.partitionKeys[0].property;
  }
}
