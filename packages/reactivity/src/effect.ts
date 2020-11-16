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
  active: boolean //active是激活effect的开关，打开会收集依赖，关闭会导致收集依赖无效
  raw: () => T // 监听函数的原始函数
  deps: Array<Dep> // 存储依赖(effect)的deps
  options: ReactiveEffectOptions // 相关选项
  allowRecurse: boolean //是否允许递归
}

//定义effectOptions类型
export interface ReactiveEffectOptions {
  lazy?: boolean // 延迟计算的标识(默认false,开启的话,effect函数不会立刻执行一次,会延迟到依赖关系被触发时才执行)
  scheduler?: (job: ReactiveEffect) => void // 自定义的依赖收集函数，一般用于外部引入@vue/reactivity时使用
  onTrack?: (event: DebuggerEvent) => void // 本地调试钩子(仅在开发模式下生效)
  onTrigger?: (event: DebuggerEvent) => void // 本地调试钩子(仅在开发模式下生效)
  onStop?: () => void //本地调试时钩子(仅在开发模式下生效)
  allowRecurse?: boolean //是否允许递归
}

//debugger 事件
export type DebuggerEvent = {
  effect: ReactiveEffect
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
} & DebuggerEventExtraInfo

// debugger扩展信息
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

//判断一个函数是否是effect,判断标识为_isEffect属性,如果不是,则没有该属性标识
export function isEffect(fn: any): fn is ReactiveEffect {
  return fn && fn._isEffect === true
}

//创建侦听器的工厂函数effect
export function effect<T = any>(
  fn: () => T, //包装了源数据的原始函数
  options: ReactiveEffectOptions = EMPTY_OBJ //配置项，可以是 { immediate, deep, flush, onTrack, onTrigger }
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
  //返回创建好的副作用函数
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
    // active标记为false，标识这个effect已经停止收集依赖了(停止依赖监听)
    effect.active = false
  }
}

let uid = 0

//创建 effect
function createReactiveEffect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions
): ReactiveEffect<T> {
  //初始化 effect 函数(effect本身是一个函数,因为函数也是object类型,因此在其上可以扩展一些有用属性)
  const effect = function reactiveEffect(): unknown {
    //当active标记为false，scheduler 为true 直接调用副作用函数
    if (!effect.active) {
      return options.scheduler ? undefined : fn()
    }
    //只有当前effect不在effectStack中，才会去执行副作用函数fn,进而进行依赖收集
    if (!effectStack.includes(effect)) {
      //执行副作用函数前(收集依赖前)，先清理一次effect的依赖(清空deps)
      // 先清理一次的目的是重新对同一个属性创建新的依赖监听时，先把原始监听的依赖移除,避免出现重复依赖收集的情况,始终保持对同一个属性的依赖不重复
      cleanup(effect)
      try {
        //当前effect 入栈,并激活为 activeEffect,然后执行副作用函数
        enableTracking()
        effectStack.push(effect)
        activeEffect = effect
        //fn为副作用函数,若该函数里的响应式对象有取值操作,则会触发getter,getter里会调用track()方法,进而实现依赖的重新收集
        return fn()
      } finally {
        //fn副作用函数执行完后,表示依赖收集完毕,则当前effect出栈,并移除激活态activeEffect
        effectStack.pop()
        resetTracking()
        activeEffect = effectStack[effectStack.length - 1]
      }
    }
  } as ReactiveEffect
  //函数也是对象类型,因此可以给effect扩展一些有用的属性
  effect.id = uid++ //id
  effect.allowRecurse = !!options.allowRecurse //是否允许递归
  effect._isEffect = true //effect 标识
  effect.active = true //激活态(为true时才允许依赖收集)
  effect.raw = fn //缓存 fn 原始副作用函数
  effect.deps = [] //存储依赖
  effect.options = options //选项
  return effect
}

// 清理依赖方法，遍历deps，并清空(因为deps中存储的effect为同时也是执行track()方法时收集进depsMap中的dep,因此此处清除也会移除掉depsMap中的
//value)
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
//执行依赖收集的方法,最终会将 当前激活态的effect 存入 targetMap 集合,这个过程被称为 "依赖收集"
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

//触发依赖更新的方法(当响应式数据更新,会遍历执行先前收集进depsMap中的副作用函数,重新收集依赖关系,并将最新值同步给依赖属性)
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
 //获取原始对象的映射依赖 depsMap
  const depsMap = targetMap.get(target)
  //如果不存在,说明不存在(未收集过)该原始对象的依赖,直接返回,也就不用去触发更新
  if (!depsMap) {
    // never been tracked
    return
  }

  //初始化一个effects集合 (set集合)
  const effects = new Set<ReactiveEffect>()
  //add effect into effects
//add是一个把每一个effect添加进effects集合的方法
  const add = (effectsToAdd: Set<ReactiveEffect> | undefined) => {
    if (effectsToAdd) {
      effectsToAdd.forEach(effect => {
        if (effect !== activeEffect || effect.allowRecurse) {
          effects.add(effect)
        }
      })
    }
  }
//如果是清除整个集合的数据，那就是集合每一项都会发生变化，所以,会将depsMap中的所有依赖项add进effects中
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    depsMap.forEach(add)
    //如果是修改数组长度操作,则将depsMap中length 对应的依赖项以及不大于新数组长度的下标对应的依赖add进effects中,进而去更新依赖
  } else if (key === 'length' && isArray(target)) {
    depsMap.forEach((dep, key) => {
      if (key === 'length' || key >= (newValue as number)) {
        add(dep)
      }
    })  
  } else {
    // schedule runs for SET | ADD | DELETE
   //  SET | ADD | DELETE 三种操作都是操作响应式对象某一个属性，所以只需要通知依赖这一个属性的状态更新即可
    if (key !== void 0) {
      //void 0 = undefined
      add(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    //对于Set集合,数组的 添加,删除元素的方法以及 Map集合的添加元素方法执行的时候并不是通过触发元素的下标或者key来更新依赖的,依赖收集的时候(track),
    //对于数组劫持的是 'length'属性,set和map分别是 ITERATE_KEY 和 MAP_KEY_ITERATE_KEY,因此这里通过分情况分别获取 length,ITERATE_KEY,MAP_KEY_ITERATE_KEY
    //对应的依赖 add进effects,然后去触发各依赖更新
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
