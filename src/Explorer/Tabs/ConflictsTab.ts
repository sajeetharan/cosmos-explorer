import * as ko from "knockout";
import * as Constants from "../../Common/Constants";
import * as DataModels from "../../Contracts/DataModels";
import * as ViewModels from "../../Contracts/ViewModels";
import { Action } from "../../Shared/Telemetry/TelemetryConstants";
import { AccessibleVerticalList } from "../Tree/AccessibleVerticalList";
import { KeyCodes } from "../../Common/Constants";
import * as ErrorParserUtility from "../../Common/ErrorParserUtility";
import ConflictId from "../Tree/ConflictId";
import editable from "../../Common/EditableUtility";
import * as HeadersUtility from "../../Common/HeadersUtility";
import TabsBase from "./TabsBase";
import { DocumentsGridMetrics } from "../../Common/Constants";
import { Splitter, SplitterBounds, SplitterDirection } from "../../Common/Splitter";
import * as TelemetryProcessor from "../../Shared/Telemetry/TelemetryProcessor";
import SaveIcon from "../../../images/save-cosmos.svg";
import DiscardIcon from "../../../images/discard.svg";
import DeleteIcon from "../../../images/delete.svg";
import { QueryIterator, ItemDefinition, Resource, ConflictDefinition } from "@azure/cosmos";
import { MinimalQueryIterator } from "../../Common/IteratorUtilities";
import Explorer from "../Explorer";
import {
  queryConflicts,
  deleteConflict,
  deleteDocument,
  createDocument,
  updateDocument
} from "../../Common/DocumentClientUtilityBase";
import { CommandButtonComponentProps } from "../Controls/CommandButton/CommandButtonComponent";

export default class ConflictsTab extends TabsBase {
  public selectedConflictId: ko.Observable<ConflictId>;
  public selectedConflictContent: ViewModels.Editable<string>;
  public selectedConflictCurrent: ViewModels.Editable<string>;
  public documentContentsGridId: string;
  public documentContentsContainerId: string;
  public isEditorDirty: ko.Computed<boolean>;
  public editorState: ko.Observable<ViewModels.DocumentExplorerState>;
  public acceptChangesButton: ViewModels.Button;
  public discardButton: ViewModels.Button;
  public deleteButton: ViewModels.Button;
  public accessibleDocumentList: AccessibleVerticalList;
  public dataContentsGridScrollHeight: ko.Observable<string>;
  public shouldShowDiffEditor: ko.Computed<boolean>;
  public shouldShowEditor: ko.Computed<boolean>;
  public shouldShowWatermark: ko.Computed<boolean>;
  public loadingConflictData: ko.Observable<boolean> = ko.observable<boolean>(false);
  public isEditorReadOnly: ko.Computed<boolean>;
  public splitter: Splitter;

  public partitionKey: DataModels.PartitionKey;
  public partitionKeyPropertyHeader: string;
  public partitionKeyProperty: string;
  public conflictOperation: ko.Observable<string> = ko.observable<string>();
  public conflictIds: ko.ObservableArray<ConflictId>;

  private _documentsIterator: MinimalQueryIterator;
  private _container: Explorer;
  private _acceptButtonLabel: ko.Observable<string> = ko.observable("Save");

  constructor(options: ViewModels.ConflictsTabOptions) {
    super(options);
    this._container = options.collection && options.collection.container;

    this.documentContentsGridId = `conflictsContentsGrid${this.tabId}`;
    this.documentContentsContainerId = `conflictsContentsContainer${this.tabId}`;
    this.editorState = ko.observable<ViewModels.DocumentExplorerState>(
      ViewModels.DocumentExplorerState.noDocumentSelected
    );
    this.selectedConflictId = ko.observable<ConflictId>();
    this.selectedConflictContent = editable.observable<any>("");
    this.selectedConflictCurrent = editable.observable<any>("");
    this.partitionKey = options.partitionKey || (this.collection && this.collection.partitionKey);
    this.conflictIds = options.conflictIds;
    this.partitionKeyPropertyHeader =
      (this.collection && this.collection.partitionKeyPropertyHeader) || this._getPartitionKeyPropertyHeader();
    this.partitionKeyProperty = !!this.partitionKeyPropertyHeader
      ? this.partitionKeyPropertyHeader
          .replace(/[/]+/g, ".")
          .substr(1)
          .replace(/[']+/g, "")
      : null;

    this.dataContentsGridScrollHeight = ko.observable<string>(null);

    // initialize splitter only after template has been loaded so dom elements are accessible
    super.onTemplateReady((isTemplateReady: boolean) => {
      if (isTemplateReady) {
        const tabContainer: HTMLElement = document.getElementById("content");
        const splitterBounds: SplitterBounds = {
          min: Constants.DocumentsGridMetrics.DocumentEditorMinWidthRatio * tabContainer.clientWidth,
          max: Constants.DocumentsGridMetrics.DocumentEditorMaxWidthRatio * tabContainer.clientWidth
        };
        this.splitter = new Splitter({
          splitterId: "h_splitter2",
          leftId: this.documentContentsContainerId,
          bounds: splitterBounds,
          direction: SplitterDirection.Vertical
        });
      }
    });

    this.accessibleDocumentList = new AccessibleVerticalList(this.conflictIds());
    this.accessibleDocumentList.setOnSelect(
      (selectedDocument: ConflictId) => selectedDocument && selectedDocument.click()
    );
    this.selectedConflictId.subscribe((newSelectedDocumentId: ConflictId) => {
      this.accessibleDocumentList.updateCurrentItem(newSelectedDocumentId);
      this.conflictOperation(newSelectedDocumentId && newSelectedDocumentId.operationType);
    });

    this.conflictIds.subscribe((newDocuments: ConflictId[]) => {
      this.accessibleDocumentList.updateItemList(newDocuments);
      this.dataContentsGridScrollHeight(
        newDocuments.length * DocumentsGridMetrics.IndividualRowHeight + DocumentsGridMetrics.BufferHeight + "px"
      );
    });

    this.isEditorDirty = ko.computed<boolean>(() => {
      switch (this.editorState()) {
        case ViewModels.DocumentExplorerState.noDocumentSelected:
        case ViewModels.DocumentExplorerState.exisitingDocumentNoEdits:
          return false;

        case ViewModels.DocumentExplorerState.newDocumentValid:
        case ViewModels.DocumentExplorerState.newDocumentInvalid:
        case ViewModels.DocumentExplorerState.exisitingDocumentDirtyInvalid:
          return true;

        case ViewModels.DocumentExplorerState.exisitingDocumentDirtyValid:
          return (
            this.selectedConflictCurrent.getEditableOriginalValue() !==
            this.selectedConflictCurrent.getEditableCurrentValue()
          );

        default:
          return false;
      }
    });

    this.acceptChangesButton = {
      enabled: ko.computed<boolean>(() => {
        switch (this.editorState()) {
          case ViewModels.DocumentExplorerState.exisitingDocumentDirtyValid:
          case ViewModels.DocumentExplorerState.exisitingDocumentNoEdits:
            return true;
        }

        return false;
      }),

      visible: ko.computed<boolean>(() => {
        return this.conflictOperation() !== Constants.ConflictOperationType.Delete || !!this.selectedConflictContent();
      })
    };

    this.discardButton = {
      enabled: ko.computed<boolean>(() => {
        switch (this.editorState()) {
          case ViewModels.DocumentExplorerState.exisitingDocumentDirtyValid:
          case ViewModels.DocumentExplorerState.exisitingDocumentDirtyInvalid:
            return true;
        }

        return false;
      }),

      visible: ko.computed<boolean>(() => {
        return this.conflictOperation() !== Constants.ConflictOperationType.Delete || !!this.selectedConflictContent();
      })
    };

    this.deleteButton = {
      enabled: ko.computed<boolean>(() => {
        switch (this.editorState()) {
          case ViewModels.DocumentExplorerState.exisitingDocumentDirtyValid:
          case ViewModels.DocumentExplorerState.exisitingDocumentNoEdits:
            return true;
        }

        return false;
      }),

      visible: ko.computed<boolean>(() => {
        return true;
      })
    };

    this.buildCommandBarOptions();
    this.shouldShowDiffEditor = ko.pureComputed<boolean>(() => {
      const documentHasContent: boolean =
        this.selectedConflictContent() != null && this.selectedConflictContent().length > 0;
      const operationIsReplace: boolean = this.conflictOperation() === Constants.ConflictOperationType.Replace;
      const isLoadingData: boolean = this.loadingConflictData();
      return documentHasContent && operationIsReplace && !isLoadingData;
    });

    this.shouldShowEditor = ko.pureComputed<boolean>(() => {
      const documentHasContent: boolean =
        this.selectedConflictContent() != null && this.selectedConflictContent().length > 0;
      const operationIsInsert: boolean = this.conflictOperation() === Constants.ConflictOperationType.Create;
      const operationIsDelete: boolean = this.conflictOperation() === Constants.ConflictOperationType.Delete;
      const isLoadingData: boolean = this.loadingConflictData();
      return documentHasContent && (operationIsInsert || operationIsDelete) && !isLoadingData;
    });

    this.shouldShowWatermark = ko.pureComputed<boolean>(() => !this.shouldShowDiffEditor() && !this.shouldShowEditor());

    this.isEditorReadOnly = ko.pureComputed<boolean>(() => {
      const operationIsDelete: boolean = this.conflictOperation() === Constants.ConflictOperationType.Delete;
      const operationIsReplace: boolean = this.conflictOperation() === Constants.ConflictOperationType.Replace;
      return operationIsDelete || operationIsReplace;
    });

    this.selectedConflictContent.subscribe((newContent: string) => this._onEditorContentChange(newContent));

    this.conflictOperation.subscribe((newOperationType: string) => {
      let operationLabel = "Save";
      if (newOperationType === Constants.ConflictOperationType.Replace) {
        operationLabel = "Update";
      }

      this._acceptButtonLabel(operationLabel);
    });
  }

  public refreshDocumentsGrid(): Promise<any> {
    // clear documents grid
    this.conflictIds([]);
    return this.createIterator()
      .then(
        // reset iterator
        iterator => {
          this._documentsIterator = iterator;
        }
      )
      .then(
        // load documents
        () => {
          return this.loadNextPage();
        }
      )
      .catch(reason => {
        const message = ErrorParserUtility.parse(reason)[0].message;
        window.alert(message);
      });
  }

  public onRefreshButtonKeyDown = (source: any, event: KeyboardEvent): boolean => {
    if (event.keyCode === KeyCodes.Enter || event.keyCode === KeyCodes.Space) {
      this.refreshDocumentsGrid();
      event.stopPropagation();
      return false;
    }
    return true;
  };

  public async onConflictIdClick(clickedDocumentId: ConflictId): Promise<any> {
    if (this.editorState() !== ViewModels.DocumentExplorerState.noDocumentSelected) {
      return;
    }

    this.editorState(ViewModels.DocumentExplorerState.exisitingDocumentNoEdits);
  }

  public onAcceptChangesClick = async (): Promise<any> => {
    if (this.isEditorDirty() && !this._isIgnoreDirtyEditor()) {
      return;
    }

    this.isExecutionError(false);
    this.isExecuting(true);

    const selectedConflict = this.selectedConflictId();

    const startKey: number = TelemetryProcessor.traceStart(Action.ResolveConflict, {
      databaseAccountName: this._container.databaseAccount().name,
      defaultExperience: this._container.defaultExperience(),
      dataExplorerArea: Constants.Areas.Tab,
      tabTitle: this.tabTitle(),
      conflictResourceType: selectedConflict.resourceType,
      conflictOperationType: selectedConflict.operationType,
      conflictResourceId: selectedConflict.resourceId
    });

    let operationPromise: Promise<any>;
    if (selectedConflict.operationType === Constants.ConflictOperationType.Replace) {
      const documentContent = JSON.parse(this.selectedConflictContent());

      operationPromise = updateDocument(
        this.collection,
        selectedConflict.buildDocumentIdFromConflict(documentContent[selectedConflict.partitionKeyProperty]),
        documentContent
      );
    }

    if (selectedConflict.operationType === Constants.ConflictOperationType.Create) {
      const documentContent = JSON.parse(this.selectedConflictContent());

      operationPromise = createDocument(this.collection, documentContent);
    }

    if (selectedConflict.operationType === Constants.ConflictOperationType.Delete && !!this.selectedConflictContent()) {
      const documentContent = JSON.parse(this.selectedConflictContent());

      operationPromise = deleteDocument(
        this.collection,
        selectedConflict.buildDocumentIdFromConflict(documentContent[selectedConflict.partitionKeyProperty])
      );
    }

    return operationPromise
      .then(
        () => {
          return deleteConflict(this.collection, selectedConflict).then(() => {
            this.conflictIds.remove((conflictId: ConflictId) => conflictId.rid === selectedConflict.rid);
            this.selectedConflictContent("");
            this.selectedConflictCurrent("");
            this.selectedConflictId(null);
            this.editorState(ViewModels.DocumentExplorerState.noDocumentSelected);
            TelemetryProcessor.traceSuccess(
              Action.ResolveConflict,
              {
                databaseAccountName: this.collection && this.collection.container.databaseAccount().name,
                defaultExperience: this.collection && this.collection.container.defaultExperience(),
                dataExplorerArea: Constants.Areas.Tab,
                tabTitle: this.tabTitle(),
                conflictResourceType: selectedConflict.resourceType,
                conflictOperationType: selectedConflict.operationType,
                conflictResourceId: selectedConflict.resourceId
              },
              startKey
            );
          });
        },
        reason => {
          this.isExecutionError(true);
          const message = ErrorParserUtility.parse(reason)[0].message;
          window.alert(message);
          TelemetryProcessor.traceFailure(
            Action.ResolveConflict,
            {
              databaseAccountName: this.collection && this.collection.container.databaseAccount().name,
              defaultExperience: this.collection && this.collection.container.defaultExperience(),
              dataExplorerArea: Constants.Areas.Tab,
              tabTitle: this.tabTitle(),
              conflictResourceType: selectedConflict.resourceType,
              conflictOperationType: selectedConflict.operationType,
              conflictResourceId: selectedConflict.resourceId
            },
            startKey
          );
        }
      )
      .finally(() => this.isExecuting(false));
  };

  public onDeleteClick = (): Promise<any> => {
    this.isExecutionError(false);
    this.isExecuting(true);

    const selectedConflict = this.selectedConflictId();

    const startKey: number = TelemetryProcessor.traceStart(Action.DeleteConflict, {
      databaseAccountName: this._container.databaseAccount().name,
      defaultExperience: this._container.defaultExperience(),
      dataExplorerArea: Constants.Areas.Tab,
      tabTitle: this.tabTitle(),
      conflictResourceType: selectedConflict.resourceType,
      conflictOperationType: selectedConflict.operationType,
      conflictResourceId: selectedConflict.resourceId
    });

    return deleteConflict(this.collection, selectedConflict)
      .then(
        () => {
          this.conflictIds.remove((conflictId: ConflictId) => conflictId.rid === selectedConflict.rid);
          this.selectedConflictContent("");
          this.selectedConflictCurrent("");
          this.selectedConflictId(null);
          this.editorState(ViewModels.DocumentExplorerState.noDocumentSelected);
          TelemetryProcessor.traceSuccess(
            Action.DeleteConflict,
            {
              databaseAccountName: this.collection && this.collection.container.databaseAccount().name,
              defaultExperience: this.collection && this.collection.container.defaultExperience(),
              dataExplorerArea: Constants.Areas.Tab,
              tabTitle: this.tabTitle(),
              conflictResourceType: selectedConflict.resourceType,
              conflictOperationType: selectedConflict.operationType,
              conflictResourceId: selectedConflict.resourceId
            },
            startKey
          );
        },
        reason => {
          this.isExecutionError(true);
          const message = ErrorParserUtility.parse(reason)[0].message;
          window.alert(message);
          TelemetryProcessor.traceFailure(
            Action.DeleteConflict,
            {
              databaseAccountName: this.collection && this.collection.container.databaseAccount().name,
              defaultExperience: this.collection && this.collection.container.defaultExperience(),
              dataExplorerArea: Constants.Areas.Tab,
              tabTitle: this.tabTitle(),
              conflictResourceType: selectedConflict.resourceType,
              conflictOperationType: selectedConflict.operationType,
              conflictResourceId: selectedConflict.resourceId
            },
            startKey
          );
        }
      )
      .finally(() => this.isExecuting(false));
  };

  public onDiscardClick = async (): Promise<any> => {
    this.selectedConflictContent(this.selectedConflictContent.getEditableOriginalValue());
    this.editorState(ViewModels.DocumentExplorerState.exisitingDocumentNoEdits);
  };

  public async onValidDocumentEdit(): Promise<any> {
    this.editorState(ViewModels.DocumentExplorerState.exisitingDocumentDirtyValid);
  }

  public async onInvalidDocumentEdit(): Promise<any> {
    if (
      this.editorState() === ViewModels.DocumentExplorerState.exisitingDocumentNoEdits ||
      this.editorState() === ViewModels.DocumentExplorerState.exisitingDocumentDirtyValid
    ) {
      this.editorState(ViewModels.DocumentExplorerState.exisitingDocumentDirtyInvalid);
    }
  }

  public onTabClick(): Promise<any> {
    return super.onTabClick().then(() => {
      this.collection && this.collection.selectedSubnodeKind(ViewModels.CollectionTabKind.Conflicts);
    });
  }

  public onActivate(): Promise<any> {
    return super.onActivate().then(() => {
      if (this._documentsIterator) {
        return this._documentsIterator;
      }

      return this.createIterator().then(
        (iterator: QueryIterator<ItemDefinition & Resource>) => {
          this._documentsIterator = iterator;
          return this.loadNextPage();
        },
        error => {
          if (this.onLoadStartKey != null && this.onLoadStartKey != undefined) {
            TelemetryProcessor.traceFailure(
              Action.Tab,
              {
                databaseAccountName: this.collection.container.databaseAccount().name,
                databaseName: this.collection.databaseId,
                collectionName: this.collection.id(),
                defaultExperience: this.collection.container.defaultExperience(),
                dataExplorerArea: Constants.Areas.Tab,
                tabTitle: this.tabTitle(),
                error: error
              },
              this.onLoadStartKey
            );
            this.onLoadStartKey = null;
          }
        }
      );
    });
  }

  public onRefreshClick(): Promise<any> {
    return this.refreshDocumentsGrid().then(() => {
      this.selectedConflictContent("");
      this.selectedConflictId(null);
      this.editorState(ViewModels.DocumentExplorerState.noDocumentSelected);
    });
  }

  public createIterator(): Promise<QueryIterator<ConflictDefinition & Resource>> {
    // TODO: Conflict Feed does not allow filtering atm
    const query: string = undefined;
    let options: any = {};
    options.enableCrossPartitionQuery = HeadersUtility.shouldEnableCrossPartitionKey();
    return queryConflicts(this.collection.databaseId, this.collection.id(), query, options);
  }

  public loadNextPage(): Promise<any> {
    this.isExecuting(true);
    this.isExecutionError(false);
    return this._loadNextPageInternal()
      .then(
        (conflictIdsResponse: DataModels.ConflictId[]) => {
          const currentConflicts = this.conflictIds();
          const currentDocumentsRids = currentConflicts.map(currentConflict => currentConflict.rid);
          const nextConflictIds = conflictIdsResponse
            // filter documents already loaded in observable
            .filter((d: any) => {
              return currentDocumentsRids.indexOf(d._rid) < 0;
            })
            // map raw response to view model
            .map((rawDocument: any) => {
              return <ConflictId>new ConflictId(this, rawDocument);
            });

          const merged = currentConflicts.concat(nextConflictIds);
          this.conflictIds(merged);
          if (this.onLoadStartKey != null && this.onLoadStartKey != undefined) {
            TelemetryProcessor.traceSuccess(
              Action.Tab,
              {
                databaseAccountName: this.collection.container.databaseAccount().name,
                databaseName: this.collection.databaseId,
                collectionName: this.collection.id(),
                defaultExperience: this.collection.container.defaultExperience(),
                dataExplorerArea: Constants.Areas.Tab,
                tabTitle: this.tabTitle()
              },
              this.onLoadStartKey
            );
            this.onLoadStartKey = null;
          }
        },
        error => {
          this.isExecutionError(true);
          if (this.onLoadStartKey != null && this.onLoadStartKey != undefined) {
            TelemetryProcessor.traceFailure(
              Action.Tab,
              {
                databaseAccountName: this.collection.container.databaseAccount().name,
                databaseName: this.collection.databaseId,
                collectionName: this.collection.id(),
                defaultExperience: this.collection.container.defaultExperience(),
                dataExplorerArea: Constants.Areas.Tab,
                tabTitle: this.tabTitle(),
                error: error
              },
              this.onLoadStartKey
            );
            this.onLoadStartKey = null;
          }
        }
      )
      .finally(() => this.isExecuting(false));
  }

  public onLoadMoreKeyInput = (source: any, event: KeyboardEvent): void => {
    if (event.keyCode === Constants.KeyCodes.Space || event.keyCode === Constants.KeyCodes.Enter) {
      this.loadNextPage();
      document.getElementById(this.documentContentsGridId).focus();
      event.stopPropagation();
    }
  };

  protected _loadNextPageInternal(): Promise<DataModels.ConflictId[]> {
    return this._documentsIterator.fetchNext().then(response => response.resources);
  }

  protected _onEditorContentChange(newContent: string) {
    try {
      const parsed: any = JSON.parse(newContent);
      this.onValidDocumentEdit();
    } catch (e) {
      this.onInvalidDocumentEdit();
    }
  }

  public async initDocumentEditorForCreate(documentId: ConflictId, documentToInsert: any): Promise<any> {
    if (documentId) {
      let parsedConflictContent: any = JSON.parse(documentToInsert);
      const renderedConflictContent: string = this.renderObjectForEditor(parsedConflictContent, null, 4);
      this.selectedConflictContent.setBaseline(renderedConflictContent);
      this.editorState(ViewModels.DocumentExplorerState.exisitingDocumentNoEdits);
    }
  }

  public async initDocumentEditorForReplace(
    documentId: ConflictId,
    conflictContent: any,
    currentContent: any
  ): Promise<any> {
    if (documentId) {
      currentContent = ConflictsTab.removeSystemProperties(currentContent);
      const renderedCurrentContent: string = this.renderObjectForEditor(currentContent, null, 4);
      this.selectedConflictCurrent.setBaseline(renderedCurrentContent);

      let parsedConflictContent: any = JSON.parse(conflictContent);
      parsedConflictContent = ConflictsTab.removeSystemProperties(parsedConflictContent);

      const renderedConflictContent: string = this.renderObjectForEditor(parsedConflictContent, null, 4);
      this.selectedConflictContent.setBaseline(renderedConflictContent);
      this.editorState(ViewModels.DocumentExplorerState.exisitingDocumentNoEdits);
    }
  }

  public async initDocumentEditorForDelete(documentId: ConflictId, documentToDelete: any): Promise<any> {
    if (documentId) {
      let parsedDocumentToDelete: any = JSON.parse(documentToDelete);
      parsedDocumentToDelete = ConflictsTab.removeSystemProperties(parsedDocumentToDelete);
      const renderedDocumentToDelete: string = this.renderObjectForEditor(parsedDocumentToDelete, null, 4);
      this.selectedConflictContent.setBaseline(renderedDocumentToDelete);
      this.editorState(ViewModels.DocumentExplorerState.exisitingDocumentNoEdits);
    }
  }

  public async initDocumentEditorForNoOp(documentId: ConflictId): Promise<any> {
    this.selectedConflictContent(null);
    this.selectedConflictCurrent(null);
    this.editorState(ViewModels.DocumentExplorerState.noDocumentSelected);
  }

  protected getTabsButtons(): CommandButtonComponentProps[] {
    const buttons: CommandButtonComponentProps[] = [];
    const label = this._acceptButtonLabel();
    if (this.acceptChangesButton.visible()) {
      buttons.push({
        iconSrc: SaveIcon,
        iconAlt: label,
        onCommandClick: this.onAcceptChangesClick,
        commandButtonLabel: label,
        ariaLabel: label,
        hasPopup: false,
        disabled: !this.acceptChangesButton.enabled()
      });
    }

    if (this.discardButton.visible()) {
      const label = "Discard";
      buttons.push({
        iconSrc: DiscardIcon,
        iconAlt: label,
        onCommandClick: this.onDiscardClick,
        commandButtonLabel: label,
        ariaLabel: label,
        hasPopup: false,
        disabled: !this.discardButton.enabled()
      });
    }

    if (this.deleteButton.visible()) {
      const label = "Delete";
      buttons.push({
        iconSrc: DeleteIcon,
        iconAlt: label,
        onCommandClick: this.onDeleteClick,
        commandButtonLabel: label,
        ariaLabel: label,
        hasPopup: false,
        disabled: !this.deleteButton.enabled()
      });
    }
    return buttons;
  }

  protected buildCommandBarOptions(): void {
    ko.computed(() =>
      ko.toJSON([
        this._acceptButtonLabel,
        this.acceptChangesButton.visible,
        this.acceptChangesButton.enabled,
        this.discardButton.visible,
        this.discardButton.enabled,
        this.deleteButton.visible,
        this.deleteButton.enabled
      ])
    ).subscribe(() => this.updateNavbarWithTabsButtons());
    this.updateNavbarWithTabsButtons();
  }

  /** Remove system properties from the JSON object.
   * This includes: _etag, _rid, _self, _attachments, _ts
   */
  public static removeSystemProperties(jsonObject: any): any {
    if (!jsonObject) {
      return null;
    }

    delete jsonObject["_etag"];
    delete jsonObject["_ts"];
    delete jsonObject["_rid"];
    delete jsonObject["_self"];
    delete jsonObject["_attachments"];

    return jsonObject;
  }

  private _isIgnoreDirtyEditor = (): boolean => {
    var msg: string = "Changes will be lost. Do you want to continue?";
    return window.confirm(msg);
  };

  private _getPartitionKeyPropertyHeader(): string {
    return (
      (this.partitionKey &&
        this.partitionKey.paths &&
        this.partitionKey.paths.length > 0 &&
        this.partitionKey.paths[0]) ||
      null
    );
  }
}
