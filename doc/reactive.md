## reactive 源码分析

### 前言

- reactive 是 vue3.0 中实现响应式系统最重要的方法之一，它接收一个普通对象然后返回该普通对象的响应式代理。
- 该响应式转换是“深层的”：会影响对象内部所有嵌套的属性，基于 ES6 的 Proxy 实现(Proxy 其实也是不支持嵌套代理，因此深层代理，也是递归出来的)。
- Proxy 是 reactive 内部的实现基础，她是直接代理整个对象，相较于 vue2.x 中的 Object.defineProperty 劫持对象的指定属性会显得格外省事和强大(毕竟拥有 13 种拦截方法，能力不是吹出来的)
- reactive 返回的代理对象不等于原始对象。建议仅使用代理对象而避免依赖原始对象(直接对原始对象进行读写操作，不会触发依赖更新和收集)

### 源码分析

#### reactive

首先我们从最核心的方法 `reactive`开始。

```js
//reactive 函数类型声明，接受一个对象，返回一个不会深度嵌套的Ref类型数据
export function reactive<T extends object>(target: T): UnwrapNestedRefs<T>

//reactive 函数实现
export function reactive(target: object) {
  // if trying to observe a readonly proxy, return the readonly version.
  //如果传入的目标对象是一个只读响应式对象,则将其直接返回
  if (target && (target as Target)[ReactiveFlags.IS_READONLY]) {
    return target
  }
  //调用createReactiveObject创建目标对象对应的响应式对象
  return createReactiveObject(
    target, //目标对象
    false, //目标对象是否是只读的
    mutableHandlers, //可变普通对象的代理handler，Object和Array
    mutableCollectionHandlers // 可变集合对象的代理handler，Set、Map、WeakMap、WeakSet
  )
}

//创建响应式对象的方法，接收一个普通对象然后返回该普通对象的响应式代理。
function createReactiveObject(
  target: Target, //目标对象
  isReadonly: boolean, //目标对象是否是只读的
  baseHandlers: ProxyHandler<any>, //可变普通对象的代理handler，Object和Array
  collectionHandlers: ProxyHandler<any> // 可变集合对象的代理handler，Set、Map、WeakMap、WeakSet
) {
  //如果不是对象,则直接返回,非对象类型不能代理(开发环境下会给出警告)
  if (!isObject(target)) {
    if (__DEV__) {
      console.warn(`value cannot be made reactive: ${String(target)}`)
    }
    return target
  }
  // target is already a Proxy, return it.
  // exception: calling readonly() on a reactive object
  //如果目标对象已经是一个响应式代理了,则直接返回,(但是在响应式对象上调用readonly方法这种情况除外，意思是readonly可以继续处理响应式对象)
  if (
    target[ReactiveFlags.RAW] &&
    !(isReadonly && target[ReactiveFlags.IS_REACTIVE])
  ) {
    return target
  }
  // target already has corresponding Proxy
  //如果目标对象已经有了相应的proxy代理(首次 createReactive 时候会往 readonlyMap或者reactiveMap 存入rawObj -> proxy 关系,所以可以检测出来),
  //则从map集合里取出对应的代理对象（同一个原始对象只能有一个代理对象，不能重复代理）
  const proxyMap = isReadonly ? readonlyMap : reactiveMap
  const existingProxy = proxyMap.get(target)
  if (existingProxy) {
    return existingProxy
  }
  // only a whitelist of value types can be observed.
  //getTargetType 方法内部会调用 targetTypeMap方法,然后会对target类型进行归类并返回其类型
  //Object,Array -> 1,Map,WeakMap,Set,WeakSet - > 2,其他无效类型(INVALID:无效类型)-> 0
  //如果传入的target类型无效则直接返回target
  const targetType = getTargetType(target)
  if (targetType === TargetType.INVALID) {
    return target
  }
  //创建并返回代理对象,这里需要注意集合类型和Object/Array的响应式handler(第二个参数),内部会有不同
  const proxy = new Proxy(
    target,
    targetType === TargetType.COLLECTION ? collectionHandlers : baseHandlers
  )
  //建立rawOject->proxy映射关系并存入 readonlyMap/reactiveMap
  proxyMap.set(target, proxy)
  return proxy
}
```

`reactive` 方法只能接收一个对象类型的参数作为入参，最终会返回这个传入对象的代理对象。在这个过程中会有一些判断。

- 1.如果传入的目标对象是一个只读响应式对象,则直接返回。
- 2.如果传入的不是对象,则直接返回,非对象类型不能代理(开发环境下会给出警告)
- 3.如果目标对象已经是一个响应式代理了,则直接返回。
- 4.如果目标对象已经有了相应的 proxy 代理，则从 readonlyMap/reactiveMap 中的映射表里取出代理对象然后返回。

如果以上条件都不满足，说明是一个原始对象则去 通过 new Proxy() 方法创建代理并存入映射表集合 map 中，这里有两点需要留一下。

- 1 对于已经是代理对象的入参，如果是通过调用 readonly 方法进来的，则不会被拦截掉，说明 readonly 可以继续处理响应式对象。
- 2.集合类型和 Object/Array 的响应式 handler(第二个参数),内部会有不同，为啥 handler 内部会有所不同呢，先卖个关子，分析到 collectionHandlers
  时候我们来分析揭晓。

这是创建一个可读写对象的响应式代理，过程中还会看到几个创建方法 `readonly`, `shallowReactive`, `shallowReadonly`,内部创建过程跟 `reactive`非常相似，简单看下吧

```js
//传入一个对象（响应式或普通）或 ref，返回一个原始对象的只读代理。一个只读的代理是“深层的”，对象内部任何嵌套的属性也都是只读的。
export function readonly<T extends object>(
  target: T
): DeepReadonly<UnwrapNestedRefs<T>> {
  return createReactiveObject(
    target,
    true,
    readonlyHandlers,
    readonlyCollectionHandlers
  )
}

// Return a reactive-copy of the original object, where only the root level
// properties are reactive, and does NOT unwrap refs nor recursively convert
// returned properties.
//只为某个对象的私有（第一层）属性创建浅层的响应式代理，不会对“属性的属性”做深层次、递归地响应式代理，而只是保留原样。
export function shallowReactive<T extends object>(target: T): T {
  return createReactiveObject(
    target,
    false,
    shallowReactiveHandlers,
    shallowCollectionHandlers
  )
}

// Return a reactive-copy of the original object, where only the root level
// properties are readonly, and does NOT unwrap refs nor recursively convert
// returned properties.
// This is used for creating the props proxy object for stateful components.
//只为某个对象的自有（第一层）属性创建浅层的只读响应式代理,不会做深层次、递归地代理，深层次的属性并不是只读的
export function shallowReadonly<T extends object>(
  target: T
): Readonly<{ [K in keyof T]: UnwrapNestedRefs<T[K]> }> {
  return createReactiveObject(
    target,
    true,
    shallowReadonlyHandlers,
    readonlyCollectionHandlers
  )
}
```
会发现与 `reactive` 创建响应式对象有两点不同： 1:指定模式不同，2: handler 不同，其余过程基本一样，这些差异化会在接下来的 `baseHandlers` 和`collectionHandlers`中体现出来，会发现 reactive 文件中代码量比较少，逻辑也比较易懂。其实这部分的关键逻辑基本都在 handler 中，分析 handler才是重头戏，走着。

#### baseHandlers
