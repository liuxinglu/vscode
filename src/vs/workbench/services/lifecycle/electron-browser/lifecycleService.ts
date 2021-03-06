/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import Severity from 'vs/base/common/severity';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import { ILifecycleService, ShutdownEvent, ShutdownReason, StartupKind } from 'vs/platform/lifecycle/common/lifecycle';
import { IMessageService } from 'vs/platform/message/common/message';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { IWindowIPCService } from 'vs/workbench/services/window/electron-browser/windowService';
import { ipcRenderer as ipc } from 'electron';
import Event, { Emitter } from 'vs/base/common/event';

export class LifecycleService implements ILifecycleService {

	private static readonly _lastShutdownReasonKey = 'lifecyle.lastShutdownReason';

	public _serviceBrand: any;

	private readonly _onWillShutdown = new Emitter<ShutdownEvent>();
	private readonly _onShutdown = new Emitter<ShutdownReason>();
	private readonly _startupKind: StartupKind;

	private _willShutdown: boolean;

	constructor(
		@IMessageService private _messageService: IMessageService,
		@IWindowIPCService private _windowService: IWindowIPCService,
		@IStorageService private _storageService: IStorageService
	) {
		this._registerListeners();

		const lastShutdownReason = this._storageService.getInteger(LifecycleService._lastShutdownReasonKey, StorageScope.WORKSPACE);
		this._storageService.remove(LifecycleService._lastShutdownReasonKey, StorageScope.WORKSPACE);
		if (lastShutdownReason === ShutdownReason.RELOAD) {
			this._startupKind = StartupKind.ReloadedWindow;
		} else if (lastShutdownReason === ShutdownReason.LOAD) {
			this._startupKind = StartupKind.ReopenedWindow;
		} else {
			this._startupKind = StartupKind.NewWindow;
		}
	}

	public get startupKind(): StartupKind {
		return this._startupKind;
	}

	public get willShutdown(): boolean {
		return this._willShutdown;
	}

	public get onWillShutdown(): Event<ShutdownEvent> {
		return this._onWillShutdown.event;
	}

	public get onShutdown(): Event<ShutdownReason> {
		return this._onShutdown.event;
	}

	private _registerListeners(): void {
		const windowId = this._windowService.getWindowId();

		// Main side indicates that window is about to unload, check for vetos
		ipc.on('vscode:beforeUnload', (event, reply: { okChannel: string, cancelChannel: string, reason: ShutdownReason }) => {
			this._willShutdown = true;
			this._storageService.store(LifecycleService._lastShutdownReasonKey, JSON.stringify(reply.reason), StorageScope.WORKSPACE);

			// trigger onWillShutdown events and veto collecting
			this.onBeforeUnload(reply.reason).done(veto => {
				if (veto) {
					this._storageService.remove(LifecycleService._lastShutdownReasonKey, StorageScope.WORKSPACE);
					this._willShutdown = false; // reset this flag since the shutdown has been vetoed!
					ipc.send(reply.cancelChannel, windowId);
				} else {
					this._onShutdown.fire(reply.reason);
					ipc.send(reply.okChannel, windowId);
				}
			});
		});
	}

	private onBeforeUnload(reason: ShutdownReason): TPromise<boolean> {
		const vetos: (boolean | TPromise<boolean>)[] = [];

		this._onWillShutdown.fire({
			veto(value) {
				vetos.push(value);
			},
			reason
		});

		if (vetos.length === 0) {
			return TPromise.as(false);
		}

		const promises: TPromise<void>[] = [];
		let lazyValue = false;

		for (let valueOrPromise of vetos) {

			// veto, done
			if (valueOrPromise === true) {
				return TPromise.as(true);
			}

			if (TPromise.is(valueOrPromise)) {
				promises.push(valueOrPromise.then(value => {
					if (value) {
						lazyValue = true; // veto, done
					}
				}, err => {
					// error, treated like a veto, done
					this._messageService.show(Severity.Error, toErrorMessage(err));
					lazyValue = true;
				}));
			}
		}
		return TPromise.join(promises).then(() => lazyValue);
	}
}
