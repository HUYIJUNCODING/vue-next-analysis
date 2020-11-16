## effect 源码分析

### 前言

- 终于到了心心念已久的 `effect` 篇了，真可谓千呼万唤始出来，费了老大的劲。 此篇章主要分析三个部分 `createReactiveEffect` 如何创建侦听函数;
  `track` 如何收集侦听函数(依赖收集)； 以及 `trigger` 如何触发侦听函数执行依赖更新。这三部分是该篇的核心内容组成，只要弄清楚了，也就知道 `effect`是怎么回事了。

### createReactiveEffect

首先从创建 `effect` 开始，不过我们需要结合两个外部调用函数作为入口点，这两个函数就是很脸熟的 `watchEffect`，`watch`。如果要问我为啥从它们开刀,而不是直接从 `effect` 函数开始，我想给你个眼神自己体会，哈哈哈（反正我挺笨的，直接看 effect 还是有很多点想不明白，需要前置引导哈）。奥对了，差点给忘记了，这两个方法在 `packages/vue/dist/vue.global.js` 中找，如果发现自己项目没有这个目录文件，那就 `npm run dev` 运行下项目。

先找到这哥俩的位置

```js
// Simple effect.
function watchEffect(effect, options) {
  return doWatch(effect, null, options)
}
// initial value for watchers to trigger on undefined initial values
const INITIAL_WATCHER_VALUE = {}
// implementation
function watch(source, cb, options) {
  if (!isFunction(cb)) {
    warn(
      `\`watch(fn, options?)\` signature has been moved to a separate API. ` +
        `Use \`watchEffect(fn, options?)\` instead. \`watch\` now only ` +
        `supports \`watch(source, cb, options?) signature.`
    )
  }
  return doWatch(source, cb, options)
}
```

我们对以上代码稍作分析下：

- 两个函数内部都调用了 `doWatch` 函数，并返回该函数的执行结果，如果看过官方文档，此时我们就可以猜到 `doWatch` 函数会返回一个停止侦听的函数。
- `watchEffect` 没有 `cb` 回调，所以第一个参数即是原始函数，也是副作用函数，`watch` 的 `cb` 回调是副作用函数
- `watch` 的 `cb` 参数如果不是一个函数类型，会报警告，但是并不会报错，说明 `cb` 还可以是其他类型，但是一般写成函数比较好。

然后我们去 `doWatch` 里面看看，貌似很长的样子（不要乱想哦），就分段看吧。

```js
function doWatch(source, cb, { immediate, deep, flush, onTrack, onTrigger } = EMPTY_OBJ, instance = currentInstance) {
if (!cb) {
  if (immediate !== undefined) {
    warn(
      `watch() "immediate" option is only respected when using the ` +
        `watch(source, callback, options?) signature.`
    )
  }
  if (deep !== undefined) {
    warn(
      `watch() "deep" option is only respected when using the ` +
        `watch(source, callback, options?) signature.`
    )
  }
}
const warnInvalidSource = s => {
  warn(
    `Invalid watch source: `,
    s,
    `A watch source can only be a getter/effect function, a ref, ` +
      `a reactive object, or an array of these types.`
  )
}
...
}
```

首先会对 `cb`（副作用函数） 是否存在进行判断，如果 `cb` 不存在，说明是 `watchEffect`，则进一步会对配置项 `immediate` 和 `deep` 属性存在进行判断，如果存在会报警告，从这里可以判断出，这两个属性按规定在 `watchEffect` 方法中是不建议配置使用的（不支持使用）。

```js
function doWatch(source, cb, { immediate, deep, flush, onTrack, onTrigger } = EMPTY_OBJ, instance = currentInstance) {
  ...
      let getter;//传递给 `effect` 方法作为第一个参数（数据源函数fn）
      let forceTrigger = false;//是 `watch` 方法中数据源为 Ref 类型时是否强制执行 `cb` 副作用函数的开关
      //对数据源 `source` 数据类型进行判断
      //如果数据源是一个 Ref，则 getter是一个返回值为解了套的ref的函数
      if (isRef(source)) {
          getter = () => source.value;
          forceTrigger = !!source._shallow;//是否强制执行副作用函数的开关
      }
      //如果数据源是一个响应式的对象，则getter是一个返回该响应式对象的函数
      else if (isReactive(source)) {
          getter = () => source;
          deep = true;//深度监听开关
      }
      //如果数据源是一个数组，则getter是一个遍历数组每一项元素然后分别对每一项元素进行类型判断后将其执行结果作为新数组元素返回这个新数组的函数。
      //watch的侦听多个数据源模式的数据源就在这里执行，返回的新数组会传递给 cb（副作用函数）作为第一个参数
      else if (isArray(source)) {
          getter = () => source.map(s => {
              if (isRef(s)) {
                  return s.value;
              }
              else if (isReactive(s)) {
                  return traverse(s);
              }
              else if (isFunction(s)) {
                  return callWithErrorHandling(s, instance, 2 /* WATCH_GETTER */);
              }
              else {
                   warnInvalidSource(s);
              }
          });
      }
    //如果数据源是一个函数，会分 cb是否存在两种情况初始化getter,如果cb存在，是 执行watch 函数，getter就是一个返回最新依赖数据的函数
    //如果不存在说明是执行watchEffect进来的，此时的getter既是数据源函数，同时也是副作用函数
      else if (isFunction(source)) {
          if (cb) {
              // getter with cb
              getter = () => callWithErrorHandling(source, instance, 2 /* WATCH_GETTER */);
          }
          else {
              // no cb -> simple effect
              getter = () => {
                  if (instance && instance.isUnmounted) {
                      return;
                  }
                  if (cleanup) {
                      cleanup();
                  }
                  return callWithErrorHandling(source, instance, 3 /* WATCH_CALLBACK */, [onInvalidate]);
              };
          }
      }
      //如果以上数据类型判断都不符合，那说明传入的数据源是一个无效的值，调用 warnInvalidSource 函数警告
      else {
          getter = NOOP;//为了不报错，会给getter一个默认函数
           warnInvalidSource(source);
      }
      //如果 cb副作用函数存在，并且 deep 为真，说明是 执行 watch 函数并且此时的数据源为一个响应式对象类型，则对
      //数据源的内部属性进行深度监听（会将对象类型的属性收集进一个set集合里面），gette函数是一个执行了属性深度监听和收集并返回这个响应式对象的函数
       if (cb && deep) {
          const baseGetter = getter;
          getter = () => traverse(baseGetter());
      }
}
...
}
```

首先定义了两个变量 `getter`，`forceTrigger` 。 `getter` 会传递给 `effect` 方法作为第一个参数（数据源函数 fn）,`forceTrigger` 是 `watch` 方法中数据源为 Ref 类型时是否强制执行 `cb` 副作用函数的开关。然后下来对数据源 `source` 数据类型进行判断：

- 如果数据源是 `Ref` 类型，则 `getter` 是一个返回值为解套的 `ref` 的函数
- 如果数据源是一个响应式的对象，则 `getter` 是一个返回该响应式对象的函数
- 如果数据源是一个数组，则 `getter`是一个遍历数组每一项元素然后分别对每一项元素进行类型判断后将其执行结果作为新数组元素然后返回这个新数组的函数（ watch 的侦听多个数据源模式的数据源就在这里执行，返回的新数组会传递给 cb（副作用函数）作为第一个参数）
- 如果数据源是一个函数，会分 `cb` 是否存在两种情况初始化 `getter`，如果 `cb` 存在，是执行 `watch` 函数进来的，`getter` 就是一个返回最新依赖数据的函数；如果不存在说明是执行 `watchEffect` 进来的，此时的 `getter` 既是数据源函数，同时也是副作用函数。

如果以上数据类型判断都不符合，那说明传入的数据源是一个无效的值，调用 warnInvalidSource 函数警告。接下来还有个判断，如果 `cb` 副作用函数存在，并且 `deep` 为真，说明是执行 `watch` 函数并且此时的数据源为一个响应式对象类型，则对数据源的内部属性进行深度监听（会将对象类型的属性收集进一个 `set` 集合里面），`getter` 函数是一个执行了属性深度监听和收集并返回这个响应式对象的函数。

```js
function doWatch(
  source,cb,{ immediate, deep, flush, onTrack, onTrigger } = EMPTY_OBJ,instance = currentInstance
) {
  ...
  let cleanup //清理上次副作用函数执行时留下的还在生效的副作用,
  //用来注册一个清理上次副作用函数执行时留下的副作用结果的失效回调函数,这个失效函数
  //被执行的时机为每次副作用函数重新执行或者当前组件卸载时,fn参数是用户自定义的清除函数
  const onInvalidate = fn => {
    //onStop每次都会被重新挂载到effect侦听函数的options配置对象上,在副作用函数下一次执行时被调用
    cleanup = runner.options.onStop = () => {
      callWithErrorHandling(fn, instance, 4 /* WATCH_CLEANUP */)
    }
  }
  //初始化旧值
  let oldValue = isArray(source) ? [] : INITIAL_WATCHER_VALUE
  //job 函数是一个执行副作用的任务函数
  const job = () => {
    //runner就是监听函数,如果active属性为false说明已经停止侦听,就直接返回,不去执行副作用
    if (!runner.active) {
      return
    }
    //cb是 watch 方法中的 副作用函数,如果存在就去执行它(副作用),如果不存在,说明是 watchEffect,则去执行runner函数,也就是effect自身
    if (cb) {
      // watch(source, cb)
      const newValue = runner()
      if (deep || forceTrigger || hasChanged(newValue, oldValue)) {
        // cleanup before running cb again
        if (cleanup) {
          cleanup()
        }
        callWithAsyncErrorHandling(cb, instance, 3 /* WATCH_CALLBACK */, [
          newValue,
          // pass undefined as the old value when it's changed for the first time
          oldValue === INITIAL_WATCHER_VALUE ? undefined : oldValue,
          onInvalidate
        ])
        oldValue = newValue
      }
    } else {
      // watchEffect
      runner()
    }
  }
  // important: mark the job as a watcher callback so that scheduler knows
  // it is allowed to self-trigger (#1727)
  job.allowRecurse = !!cb
}
...
```

可以看到 `cleanup` 在 `onInvalidate` 函数中被赋值,是 `onStop` 清理函数的引用。会在副作用函数每下一次执行时被调用，用来清除上次副作用函数执行时留下的还在生效的副作用,`onInvalidate` 是用来注册一个清理上次副作用函数执行时留下的副作用的失效回调函数,这个失效函数被执行的时机为每次副作用函数重新执行或者当前组件卸载时,fn 参数是用户自定义的清除函数。下来声明一个变量 `oldValue` 用来保存旧值，job 函数是一个执行副作用的任务函数，其内部会通过 判断 `cb`副作用函数是否存在来区分是 `watchEffect` 和 `watch` 从而执行各自的副作用。

```js
function doWatch(
  source,cb,{ immediate, deep, flush, onTrack, onTrigger } = EMPTY_OBJ,instance = currentInstance
) {
  ...
  let scheduler
if (flush === 'sync') {
  //直接等于job，会在组件更新时执行，可以与 pre对比，没有对于实例以及实例目前的状态判断，因此会组件更新时同步执行副作用
  scheduler = job
} else if (flush === 'post') {
  //组件更新后执行，会发现job每次都会被先推入一个队列而不是去立刻执行副作用
  scheduler = () => queuePostRenderEffect(job, instance && instance.suspense)
} else {
  // default: 'pre'
  scheduler = () => {
    //如果当前组件状态是已更新完成，则会将 job 推入一个 queuePreFlushCb 队列，这个队列会在组件下次重新更新之前执行
    if (!instance || instance.isMounted) {
      queuePreFlushCb(job)
    } else {
      // with 'pre' option, the first call must happen before
      // the component is mounted so it is called synchronously.
      //如果执行这里表示此时是处于setup()函数执行时（组件刚开始初始化）
      job()
    }
  }
}
...
}
```

`scheduler` 是一个调度器函数，负责调度执行 `job` 。`flush` 是 `options` 的一个配置属性，默认等于 `pre` 表示每次都在组件更新之前重新运行
副作用函数，还可以手动指定值为 `sync` 和 `post` ，`sync` 表示在组件每次更新时同步执行副作用函数，`post` 则是在组件更新之后执行副作用函数，
因此通过为 `job` 指定不同属性可以控制副作用执行的时机，`flush` 对于 `watch` 和 `watchEffect` 都适用。

```js
function doWatch(
  source,cb,{ immediate, deep, flush, onTrack, onTrigger } = EMPTY_OBJ,instance = currentInstance
) {
  ...
       //创建侦听函数
        const runner = effect(getter, {
          lazy: true,
          onTrack,
          onTrigger,
          scheduler
      });
      //将侦听器收集进当前组件的全局属性effects（数组）中，我猜跟组件卸载时去停止侦听器有关
      recordInstanceBoundEffect(runner);
      // initial run
      //如果cb副作用回调存在，表示是watch，如果 options 还制定了 immediate 为 true,说明要求是侦听函数初始化完成立即执行一次副作用，默认是懒执行（在源数据被改变时候才去执行副作用）
      if (cb) {
        //立即执行副作用
          if (immediate) {
              job();
          }
          //默认懒执行
          else {
              oldValue = runner();
          }
      }
      //组件更新完成后再去初始化执行 `watchEffect` 的侦听函数
      else if (flush === 'post') {
          queuePostRenderEffect(runner, instance && instance.suspense);
      }
      //组件初始化完成之前，也就是侦听器函数初始化完成就立刻执行一次副作用（watchEffect）
      else {
          runner();//执行 effect
      }
      //返回一个执行后会停止侦听的函数
      return () => {
          stop(runner);
          if (instance) {
              remove(instance.effects, runner);
          }
      };
  ...
}
```
最后一段了，下来是调用 `effect.ts` 文件中的 `effect` 方法去创建侦听函数，侦听函数创建好以后会被返回，这里用 `runner` 来接收，所以当执行 `runner` 函数时候就表示侦听器被触发了，此时此刻要么是初始化时的依赖收集，要么就是值变了引起的依赖更新，最后 `doWatch` 函数会返回一个可以用来显式停止侦听的函数。它内部通过调用 stop 方法，来解除侦听器中的所有依赖，从而达到解除侦听的效果。

好了，到这里我们就算把 `doWatch` 函数内部的执行流程大致的分析完了，`doWatch` 内部其实就是一些围绕侦听器所做的初始化工作，但是我们还似乎还不清楚侦听函数的具体创建过程。所以趁热打铁，我们这就去`effect.ts` 里找 `effect` 方法，它就是去创建一个侦听函数的入口。
