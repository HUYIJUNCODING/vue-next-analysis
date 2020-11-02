import { TrackOpTypes, TriggerOpTypes } from './operations'
import { EMPTY_OBJ, isArray, isIntegerKey, isMap } from '@vue/shared'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type Dep = Set<ReactiveEffect>
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>()

//定义effect类型
export interface ReactiveEffect<T = any> {
  (): T //ReactiveEffect函数
  _isEffect: true //用来标识是effect类型
  id: number //id号
  active: boolean //active是effect激活的开关，打开会收集依赖，关闭会导致收集依赖无效
  raw: () => T // 原始监听函数
  deps: Array<Dep>// 存储依赖(effect)的deps
  options: ReactiveEffectOptions // 相关选项
  allowRecurse: boolean//是否允许递归
}

//定义effectOptions类型
export interface ReactiveEffectOptions {
  lazy?: boolean// 延迟计算的标识(默认false,开启的话,effect函数不会立刻执行一次,会延迟到依赖关系被触发时才执行)
  scheduler?: (job: ReactiveEffect) => void// 自定义的依赖收集函数，一般用于外部引入@vue/reactivity时使用
  onTrack?: (event: DebuggerEvent) => void // 本地调试钩子(仅在开发模式下生效)
  onTrigger?: (event: DebuggerEvent) => void // 本地调试钩子(仅在开发模式下生效)
  onStop?: () => void //本地调试时钩子(仅在开发模式下生效)
  allowRecurse?: boolean//是否允许递归
}

export type DebuggerEvent = {
  effect: ReactiveEffect
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
} & DebuggerEventExtraInfo

export interface DebuggerEventExtraInfo {
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

//effectStack用于存放所有effect的数组
const effectStack: ReactiveEffect[] = []
//当前被激活的effect
let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

//判断一个含漱液是否是effect,判断标识为_isEffect属性,如果不是,则没有该属性标识
export function isEffect(fn: any): fn is ReactiveEffect {
  return fn && fn._isEffect === true
}

//effect函数(依赖监听函数)
export function effect<T = any>(
  fn: () => T,//监听函数(其实这里称呼为副作用函数更为贴切,官方文档就是这样叫的)
  options: ReactiveEffectOptions = EMPTY_OBJ //选项 
): ReactiveEffect<T> {
  //如果fn 已经是一个effect,则直接从raw获取,则不用去重新创建(已经创建过了,可以理解为直接从缓存中拿)
  if (isEffect(fn)) {
    fn = fn.raw
  }
  //初始化 effect (createReactiveEffect)
  const effect = createReactiveEffect(fn, options)
  //这里就是optins选项,默认effect会立即执行,可以设置lazy
  if (!options.lazy) {
    effect()
  }
  return effect
}

//停止侦听的函数(该函数会在watch/watchEffect返回的函数中调用,例如官方文档所说的stop(),内部就是调用的是该函数来停止依赖监听)
export function stop(effect: ReactiveEffect) {
    // 如果当前effect是active的,则清除其内部所有依赖(清空deps)
  if (effect.active) {
     // 清除effect的所有依赖
    cleanup(effect)
     // 如果有onStop钩子，调用该钩子函数(会最为选项参数传入)
    if (effect.options.onStop) {
      effect.options.onStop()
    }
    // active标记为false，标识这个effect已经停止收集依赖了(停止了依赖监听)
    effect.active = false
  }
}

let uid = 0

//创建 effect
function createReactiveEffect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions
): ReactiveEffect<T> {
  //初始化 effect 函数(effect本身是一个函数,因为函数也是object类型,因此在其上又可以扩展一些有用属性)
  const effect = function reactiveEffect(): unknown {
    //当active标记为false，直接调用原始监听函数
    if (!effect.active) {
      return options.scheduler ? undefined : fn()
    }
    if (!effectStack.includes(effect)) {
      cleanup(effect)
      try {
        //effect 入栈,并激活为 activeEffect,然后执行fn effect回调
        enableTracking()
        effectStack.push(effect)
        activeEffect = effect
        return fn()
      } finally {
        //effect 回调执行完后(触发依赖更新完成,effect出栈)
        effectStack.pop()
        resetTracking()
        activeEffect = effectStack[effectStack.length - 1]
      }
    }
  } as ReactiveEffect
  //函数也是对象类型,因此可以给effect扩展一些有用的属性
  effect.id = uid++
  effect.allowRecurse = !!options.allowRecurse
  effect._isEffect = true //effect 标识
  effect.active = true
  effect.raw = fn //缓存 fn
  effect.deps = []
  effect.options = options
  return effect
}

function cleanup(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}
//全局开关变量，默认打开track，如果关闭track，则会导致 Vue 内部停止对变化进行追踪
let shouldTrack = true
const trackStack: boolean[] = []

export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}
//最终会将 activeEffect 存入 targetMap 集合,这个过程被称为 "依赖收集"
export function track(target: object, type: TrackOpTypes, key: unknown) {
  //shouldTrack 开关关闭 或者 activeEffect 为 undefined 则直接return,说明无依赖项要被收集
  if (!shouldTrack || activeEffect === undefined) {
    return
  }
  //targetMap用来存放target响应式对象与dep依赖关系的集合
  let depsMap = targetMap.get(target)
  //如果depsMap不存在,则以target为key,new Map()为value,创建一条target的依赖空记录(depsMap为空map集合)
  if (!depsMap) {
    targetMap.set(target, (depsMap = new Map())) // targetMap : [[target:Ref实例对象/proxy代理对象,depsMap:Map实例]]
  }
  //检索实例对象.key(也就是RefInstance.value) 是否被追踪过
  //如果当前key在depsMap中未记录过,说明depsMap中未收集过关于此key的依赖关系,则创建一条当前key的空依赖记录
  let dep = depsMap.get(key)
  //没有则创建一条记录,set进targetMap(Ref中value作为key)
  if (!dep) {
    depsMap.set(key, (dep = new Set())) //depsMap : [['value',[fn]: set]]
  }
  //dep是存放依赖函数effect的集合,先判断是否已存在此依赖,如果没有,则添加进来(依赖收集最核心地方)
  if (!dep.has(activeEffect)) {
    dep.add(activeEffect)
    //更新effect里的deps属性,将dep也放到effect.deps里，用于描述当前响应式对象的依赖
    activeEffect.deps.push(dep) // deps: [[fn,...],...] fn: effect
    //开发环境下，触发相应的钩子函数(调试钩子)
    if (__DEV__ && activeEffect.options.onTrack) {
      activeEffect.options.onTrack({
        effect: activeEffect,
        target,
        type,
        key
      })
    }
  }
}

//触发依赖，使用 targetMap
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  //检索依赖,如果依赖不存在直接return ['value',[fn,...]]
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    return
  }

  //初始化一个effects set集合,用来收集即将要触发的effect
  const effects = new Set<ReactiveEffect>()
  //add effect into effects
  const add = (effectsToAdd: Set<ReactiveEffect> | undefined) => {
    if (effectsToAdd) {
      effectsToAdd.forEach(effect => {
        if (effect !== activeEffect || effect.allowRecurse) {
          effects.add(effect)
        }
      })
    }
  }

  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    depsMap.forEach(add)
  } else if (key === 'length' && isArray(target)) {
    depsMap.forEach((dep, key) => {
      if (key === 'length' || key >= (newValue as number)) {
        add(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    // key 如果不等于 undefined,执行 effect add  effects操作
    if (key !== void 0) {
      //void 0 = undefined
      add(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    switch (type) {
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          add(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          add(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  //执行effect的 forEach回调函数
  const run = (effect: ReactiveEffect) => {
    if (__DEV__ && effect.options.onTrigger) {
      effect.options.onTrigger({
        effect,
        target,
        key,
        type,
        newValue,
        oldValue,
        oldTarget
      })
    }
    if (effect.options.scheduler) {
      effect.options.scheduler(effect)
    } else {
      effect()
    }
  }
  //迭代触发effects 中的effect
  effects.forEach(run)
}
