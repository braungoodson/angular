/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {inject, describe, it, iit, expect, beforeEach, beforeEachProviders,} from '@angular/core/testing/testing_internal';
import {browserDetection} from '@angular/platform-browser/testing/browser_util';
import {createPairedMessageBuses} from './web_worker_test_util';
import {Serializer, PRIMITIVE} from '@angular/platform-browser/src/web_workers/shared/serializer';
import {ServiceMessageBroker, ServiceMessageBroker_} from '@angular/platform-browser/src/web_workers/shared/service_message_broker';
import {ObservableWrapper, PromiseWrapper} from '../../../src/facade/async';
import {provide} from '@angular/core';
import {ON_WEB_WORKER} from '@angular/platform-browser/src/web_workers/shared/api';
import {RenderStore} from '@angular/platform-browser/src/web_workers/shared/render_store';

export function main() {
  const CHANNEL = 'UIMessageBroker Test Channel';
  const TEST_METHOD = 'TEST_METHOD';
  const PASSED_ARG_1 = 5;
  const PASSED_ARG_2 = 'TEST';
  const RESULT = 20;
  const ID = 'methodId';

  beforeEachProviders(() => [Serializer, {provide: ON_WEB_WORKER, useValue: true}, RenderStore]);

  describe('UIMessageBroker', () => {
    var messageBuses: any /** TODO #9100 */;

    beforeEach(() => {
      messageBuses = createPairedMessageBuses();
      messageBuses.ui.initChannel(CHANNEL);
      messageBuses.worker.initChannel(CHANNEL);
    });
    it('should call registered method with correct arguments',
       inject([Serializer], (serializer: Serializer) => {
         var broker = new ServiceMessageBroker_(messageBuses.ui, serializer, CHANNEL);
         broker.registerMethod(TEST_METHOD, [PRIMITIVE, PRIMITIVE], (arg1, arg2) => {
           expect(arg1).toEqual(PASSED_ARG_1);
           expect(arg2).toEqual(PASSED_ARG_2);
         });
         ObservableWrapper.callEmit(
             messageBuses.worker.to(CHANNEL),
             {'method': TEST_METHOD, 'args': [PASSED_ARG_1, PASSED_ARG_2]});
       }));

    it('should return promises to the worker', inject([Serializer], (serializer: Serializer) => {
         var broker = new ServiceMessageBroker_(messageBuses.ui, serializer, CHANNEL);
         broker.registerMethod(TEST_METHOD, [PRIMITIVE], (arg1) => {
           expect(arg1).toEqual(PASSED_ARG_1);
           return PromiseWrapper.wrap(() => { return RESULT; });
         });
         ObservableWrapper.callEmit(
             messageBuses.worker.to(CHANNEL),
             {'method': TEST_METHOD, 'id': ID, 'args': [PASSED_ARG_1]});
         ObservableWrapper.subscribe(messageBuses.worker.from(CHANNEL), (data: any) => {
           expect(data.type).toEqual('result');
           expect(data.id).toEqual(ID);
           expect(data.value).toEqual(RESULT);
         });
       }));
  });
}
